import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, status, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr

# Updated: AuthApiError is now imported directly from supabase, not gotrue
from supabase import Client, create_client, AuthApiError

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]

# Requires you to add this to your .env file for the delete_account route
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

if SUPABASE_SERVICE_ROLE_KEY:
    admin_supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

app = FastAPI(title="ShopSphere API")

# Updated: Explicitly allows both localhost variations to prevent CORS errors
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500"
    ],
    allow_credentials=True, 
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Pydantic Models ---

class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    password: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class UpdateProfileRequest(BaseModel):
    full_name: str


# --- Core System Routes ---

@app.get("/health")
def health():
    return {"status": "ok"}


# --- Authentication Routes ---

@app.post("/auth/register", status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest):
    try:
        result = supabase.auth.sign_up(
            {
                "email": payload.email,
                "password": payload.password,
                # This full_name is what your new SQL Trigger catches!
                "options": {"data": {"full_name": payload.name}},
            }
        )
    except AuthApiError as e:
        raise HTTPException(status_code=400, detail=e.message)

    if result.session is None:
        return {
            "message": "Account created. Check your email to confirm before logging in.",
            "user_id": result.user.id,
        }

    return {
        "message": "Account created and signed in.",
        "access_token": result.session.access_token,
        "user_id": result.user.id,
    }


@app.post("/auth/login")
def login(payload: LoginRequest, response: Response):
    try:
        result = supabase.auth.sign_in_with_password(
            {"email": payload.email, "password": payload.password}
        )
    except AuthApiError as e:
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    # Securely set the HttpOnly cookie
    response.set_cookie(
        key="access_token",
        value=result.session.access_token,
        httponly=True,
        samesite="none", # Changed from lax to none for cross-domain cookies
        secure=True,     # Changed from False to True because Render uses HTTPS
    )

    return {
        "message": "Signed in securely.",
        "user_id": result.user.id,
        "email": result.user.email,
    }


# --- User Profile Routes (Interacting with the new public.users table) ---

@app.get("/users/{user_id}")
def get_user_profile(user_id: str):
    response = supabase.table("users").select("*").eq("id", user_id).execute()
    
    if not response.data:
        raise HTTPException(status_code=404, detail="User not found")
        
    return response.data[0]


@app.put("/users/{user_id}")
def update_user_profile(user_id: str, payload: UpdateProfileRequest):
    response = supabase.table("users").update(
        {"full_name": payload.full_name}
    ).eq("id", user_id).execute()
    
    if not response.data:
        raise HTTPException(status_code=400, detail="Update failed")
        
    return {"message": "Profile updated successfully", "data": response.data[0]}


@app.delete("/users/{user_id}")
def delete_account(user_id: str):
    if not SUPABASE_SERVICE_ROLE_KEY:
         raise HTTPException(
             status_code=500, 
             detail="Service role key missing. Cannot perform admin deletions."
        )
    
    try:
        admin_supabase.auth.admin.delete_user(user_id)
    except Exception as e:
         raise HTTPException(status_code=400, detail=str(e))
         
    return {"message": "Account and public profile completely wiped."}