let map = null;
let marker = null;
let userLocation = null;

document.addEventListener("DOMContentLoaded", async () => {
  const session = await requireAuth();
  if (!session) return;

  document.getElementById("logout-btn").addEventListener("click", logout);

  try {
    const profile = await getProfile();
    if (profile.role !== "customer") {
      window.location.href = "/mechanic";
      return;
    }
    document.getElementById("user-name").textContent = profile.full_name;
  } catch {
    window.location.href = "/signup?complete=1";
    return;
  }

  await initMap();
  document.getElementById("find-form").addEventListener("submit", onFindMechanic);
  document.getElementById("request-form").addEventListener("submit", onRequestService);

  // Polls active database statuses every 8 seconds to capture job updates instantly
  setInterval(loadMyRequests, 8000);
  loadMyRequests();
});

async function initMap() {
  try {
    userLocation = await getCurrentPosition();
  } catch {
    // Defaults location to regional fallback baseline matrix if browser blocking occurs
    userLocation = { lat: 19.076, lng: 72.8777 };
  }

  map = L.map("map").setView([userLocation.lat, userLocation.lng], 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  const userIcon = L.divIcon({
    className: "user-marker",
    html: `<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="14" fill="rgba(71,118,230,0.2)" stroke="rgba(71,118,230,1)" stroke-width="2"/><circle cx="16" cy="16" r="6" fill="rgba(71,118,230,1)"/></svg>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });

  marker = L.marker([userLocation.lat, userLocation.lng], { icon: userIcon }).addTo(map);
  marker.bindPopup("<b>Your Location</b>").openPopup();
}

async function onFindMechanic(e) {
  e.preventDefault();
  const alertEl = document.getElementById("find-alert");
  hideAlert(alertEl);

  const vehicleType = document.getElementById("vehicle_type").value;

  try {
    if (!userLocation) userLocation = await getCurrentPosition();
    const data = await apiFetch(
      `/api/mechanics/nearby?lat=${userLocation.lat}&lng=${userLocation.lng}&vehicle_type=${vehicleType}`
    );

    const list = document.getElementById("mechanics-list");
    list.innerHTML = "";

    if (!data.mechanics.length) {
      list.innerHTML = "<p style='color:var(--text-dim); font-size:13px;'>No matching mechanics online nearby. Try scanning again later.</p>";
      return;
    }

    const mechanicIcon = L.divIcon({
      className: "mechanic-marker",
      html: `<svg width="28" height="28" viewBox="0 0 28 28" fill="none"><circle cx="14" cy="14" r="12" fill="rgba(255,122,69,0.2)" stroke="rgba(255,122,69,1)" stroke-width="2"/><text x="14" y="17" font-size="12" font-weight="bold" fill="rgba(255,122,69,1)" text-anchor="middle">⚙</text></svg>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    data.mechanics.forEach((m) => {
      L.marker([m.lat, m.lng], { icon: mechanicIcon })
        .addTo(map)
        .bindPopup(`<b>${m.full_name}</b><br>${formatDistance(m.distance_km)}`);

      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <h4>${m.full_name}</h4>
        <p>${formatDistance(m.distance_km)} away · Contact: ${m.phone || 'N/A'}</p>
      `;
      list.appendChild(item);
    });
  } catch (err) {
    showAlert(alertEl, err.message);
  }
}

async function onRequestService(e) {
  e.preventDefault();
  const alertEl = document.getElementById("request-alert");
  hideAlert(alertEl);

  const issue = document.getElementById("issue").value.trim();
  const vehicleType = document.getElementById("req_vehicle_type").value;

  try {
    if (!userLocation) userLocation = await getCurrentPosition();
    await apiFetch("/api/requests", {
      method: "POST",
      body: JSON.stringify({
        issue_description: issue,
        vehicle_type: vehicleType,
        lat: userLocation.lat,
        lng: userLocation.lng,
      }),
    });

    showAlert(alertEl, "Emergency request broadcasted! A nearby technician will accept soon.", "success");
    document.getElementById("issue").value = "";
    loadMyRequests();
  } catch (err) {
    showAlert(alertEl, err.message);
  }
}

async function loadMyRequests() {
  const list = document.getElementById("requests-list");
  try {
    const data = await apiFetch("/api/requests/mine");
    list.innerHTML = "";

    if (!data.requests.length) {
      list.innerHTML = "<p style='color:var(--text-dim); font-size:14px;'>No current distress logs active.</p>";
      return;
    }

    data.requests.forEach((req) => {
      const mechanic = req.profiles;
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <span class="${statusClass(req.status)}">${req.status}</span>
        <h4>${req.vehicle_type.toUpperCase()} · Request Code #${req.id}</h4>
        <p style="margin:4px 0 8px 0;">Issue: ${req.issue_description}</p>
        ${
          mechanic
            ? `<p style="color:var(--success)">Assigned Tech: ${mechanic.full_name} · ${mechanic.phone || ''}</p>`
            : "<p style='color:var(--accent-coral)'>Status: Dispatching nearby...</p>"
        }
        ${
          req.status === "accepted"
            ? `<button class="btn btn-success btn-block" style="margin-top:10px; width:100%;" data-id="${req.id}">Mark Breakdown Resolved</button>`
            : ""
        }
      `;
      list.appendChild(item);
    });

    list.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await apiFetch(`/api/requests/${btn.dataset.id}/complete`, { method: "POST" });
        loadMyRequests();
      });
    });
  } catch {
    list.innerHTML = "<p style='color:var(--error); font-size:13px;'>Could not process request sync log data.</p>";
  }
}