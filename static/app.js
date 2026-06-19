let supabaseClient = null;
let appConfig = null;

// Communicates with backend initialization route to ingest platform environment config variables
async function loadConfig() {
  if (appConfig) return appConfig;
  const res = await fetch("/api/config");
  appConfig = await res.json();
  return appConfig;
}

// Instantiates the global Supabase Client connection engine
async function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const config = await loadConfig();
  if (!window.supabase) {
    throw new Error("Supabase SDK not loaded on client webpage infrastructure.");
  }
  supabaseClient = window.supabase.createClient(
    config.supabaseUrl,
    config.supabaseAnonKey
  );
  return supabaseClient;
}

// Extracts active authorization session state strings to forward over the wire
async function getAccessToken() {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  return data.session?.access_token || null;
}

// Global fetch wrapper injecting Bearer signature headers into protected backend API endpoints
async function apiFetch(path, options = {}) {
  const token = await getAccessToken();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || "Request failed operational pipeline execution.");
  }
  return data;
}

function showAlert(el, message, type = "error") {
  el.textContent = message;
  el.className = `alert alert-${type}`;
  el.classList.remove("hidden");
}

function hideAlert(el) {
  el.classList.add("hidden");
}

// Navigation guard ensuring session authenticity across route transitions
async function requireAuth(redirectTo = "/login") {
  const sb = await getSupabase();
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    window.location.href = redirectTo;
    return null;
  }
  return data.session;
}

async function getProfile() {
  return apiFetch("/api/profile");
}

async function redirectByRole() {
  try {
    const profile = await getProfile();
    window.location.href = profile.role === "mechanic" ? "/mechanic" : "/customer";
  } catch {
    window.location.href = "/signup?complete=1";
  }
}

async function logout() {
  const sb = await getSupabase();
  await sb.auth.signOut();
  window.location.href = "/login";
}

// Resolves client GPS coordinate matrices seamlessly via native browser geolocation APIs
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation capabilities unsupported by client agent."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

function statusClass(status) {
  return `status-pill status-${status}`;
}

function formatDistance(km) {
  return km < 1 ? `${Math.round(km * 1000)} m away` : `${km.toFixed(1)} km away`;
}