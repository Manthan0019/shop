import os
import math
from typing import List, Optional
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, status, Response, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from supabase import Client, create_client, AuthApiError

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]

supabase: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

app = FastAPI(title="MechFinder API")

allowed_origins = [
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "https://shop-1-wtfm.onrender.com"  # Replace with your frontend Render production domain
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True, 
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Pydantic Data Models ---

class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    password: str
    phone: str
    role: str  # 'customer' or 'mechanic'
    vehicle_types: Optional[List[str]] = []

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class LocationStatusUpdate(BaseModel):
    is_online: bool
    lat: Optional[float] = None
    lng: Optional[float] = None

class ServiceRequestPayload(BaseModel):
    issue_description: str
    vehicle_type: str
    lat: float
    lng: float

# --- Authentication Dependence Injector ---

async def get_current_user_id(request: Request) -> str:
    # 1. Attempt token recovery via Bearer header authorization (Postman)
    auth_header = request.headers.get("Authorization")
    token = None
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split(" ")[1]
    else:
        # 2. Fallback to HttpOnly cookie transport (Web Browser client)
        token = request.cookies.get("access_token")
        
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authorization token.")
    
    try:
        user_response = supabase.auth.get_user(token)
        return user_response.user.id
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token or expired session.")

# --- Core API Routes ---

@app.get("/health")
def health_check():
    return {"status": "ok", "service": "MechFinder Engine"}

@app.post("/auth/register", status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest):
    if payload.role not in ['customer', 'mechanic']:
        raise HTTPException(status_code=400, detail="Invalid role specification.")
    try:
        result = supabase.auth.sign_up({
            "email": payload.email,
            "password": payload.password,
            "options": {
                "data": {
                    "full_name": payload.name,
                    "phone": payload.phone,
                    "role": payload.role,
                    "vehicle_types": payload.vehicle_types
                }
            }
        })
        return {"message": "User registered successfully.", "user_id": result.user.id}
    except AuthApiError as e:
        raise HTTPException(status_code=400, detail=e.message)

@app.post("/auth/login")
def login(payload: LoginRequest, response: Response):
    try:
        result = supabase.auth.sign_in_with_password({"email": payload.email, "password": payload.password})
        
        response.set_cookie(
            key="access_token",
            value=result.session.access_token,
            httponly=True,
            samesite="none",
            secure=True,
        )
        
        # Fetch verified profile information
        profile = supabase.table("profiles").select("*").eq("id", result.user.id).execute()
        profile_data = profile.data[0] if profile.data else {}

        return {
            "message": "Authorized safely.",
            "token": result.session.access_token,
            "profile": profile_data
        }
    except AuthApiError:
        raise HTTPException(status_code=401, detail="Invalid email or password parameters.")

@app.get("/api/profile")
def get_my_profile(user_id: str = Depends(get_current_user_id)):
    response = supabase.table("profiles").select("*").eq("id", user_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Profile record missing.")
    return response.data[0]

# --- Mechanic Location Tracking & Core Search Features ---

@app.put("/api/mechanic/status")
def update_mechanic_status(payload: LocationStatusUpdate, user_id: str = Depends(get_current_user_id)):
    update_data = {"is_online": payload.is_online}
    if payload.is_online:
        if payload.lat is None or payload.lng is None:
            raise HTTPException(status_code=400, detail="Coordinates mandatory when changing status to online.")
        update_data["lat"] = payload.lat
        update_data["lng"] = payload.lng
        
    response = supabase.table("profiles").update(update_data).eq("id", user_id).execute()
    return {"message": "Status updated successfully.", "data": response.data}

@app.get("/api/mechanics/nearby")
def locate_nearby_mechanics(lat: float, lng: float, vehicle_type: str):
    response = supabase.table("profiles").select("*").eq("role", "mechanic").eq("is_online", True).execute()
    
    nearby_mechanics = []
    for mech in response.data:
        if vehicle_type in mech.get("vehicle_types", []):
            # Haversine Distance algorithm calculation logic
            m_lat, m_lng = float(mech["lat"]), float(mech["lng"])
            rad_lat1, rad_lon1, rad_lat2, rad_lon2 = map(math.radians, [lat, lng, m_lat, m_lng])
            dlon = rad_lon2 - rad_lon1
            dlat = rad_lat2 - rad_lat1
            a = math.sin(dlat/2)**2 + math.cos(rad_lat1) * math.cos(rad_lat2) * math.sin(dlon/2)**2
            c = 2 * math.asin(math.sqrt(a))
            distance_km = 6371 * c
            
            mech["distance_km"] = distance_km
            nearby_mechanics.append(mech)
            
    nearby_mechanics.sort(key=lambda x: x["distance_km"])
    return {"mechanics": nearby_mechanics}

# --- Service Requests Operations Layer ---

@app.post("/api/requests")
def dispatch_service_request(payload: ServiceRequestPayload, user_id: str = Depends(get_current_user_id)):
    request_data = {
        "customer_id": user_id,
        "vehicle_type": payload.vehicle_type,
        "issue_description": payload.issue_description,
        "lat": payload.lat,
        "lng": payload.lng,
        "status": "pending"
    }
    response = supabase.table("requests").insert(request_data).execute()
    return {"message": "Roadside assistance request broadcasted.", "request": response.data[0]}

@app.get("/api/requests/mine")
def get_my_active_requests(user_id: str = Depends(get_current_user_id)):
    profile = supabase.table("profiles").select("role").eq("id", user_id).execute()
    if not profile.data:
        raise HTTPException(status_code=404, detail="User validation path error.")
    
    role = profile.data[0]["role"]
    query_field = "mechanic_id" if role == "mechanic" else "customer_id"
    
    response = supabase.table("requests").select("*, profiles:customer_id(full_name, phone)").eq(query_field, user_id).execute()
    return {"requests": response.data}

@app.get("/api/requests/pending")
def view_regional_pending_jobs(user_id: str = Depends(get_current_user_id)):
    # Verify mechanic profiles specializations
    mech = supabase.table("profiles").select("vehicle_types").eq("id", user_id).execute()
    if not mech.data:
        raise HTTPException(status_code=403, detail="Access verification rejected.")
    
    types = mech.data[0]["vehicle_types"]
    response = supabase.table("requests").select("*, profiles:customer_id(full_name, phone)").eq("status", "pending").ov("vehicle_type", types).execute()
    return {"requests": response.data}

@app.post("/api/requests/{request_id}/accept")
def accept_roadside_job(request_id: int, user_id: str = Depends(get_current_user_id)):
    response = supabase.table("requests").update({"status": "accepted", "mechanic_id": user_id}).eq("id", request_id).eq("status", "pending").execute()
    if not response.data:
        raise HTTPException(status_code=400, detail="Job has already been accepted or modified.")
    return {"message": "Job successfully assigned to your tracking layout.", "data": response.data[0]}

@app.post("/api/requests/{request_id}/complete")
def finalize_service_request(request_id: int, user_id: str = Depends(get_current_user_id)):
    response = supabase.table("requests").update({"status": "completed"}).eq("id", request_id).execute()
    return {"message": "Job successfully closed.", "data": response.data[0]}