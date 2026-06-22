let mechanicLocation = null;
let pollTimer = null;
let map = null;
let mechanicMarker = null;
let pendingMarkers = [];

document.addEventListener("DOMContentLoaded", async () => {
  const session = await requireAuth();
  if (!session) return;

  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("online-toggle").addEventListener("change", onToggleOnline);

  try {
    const profile = await getProfile();
    if (profile.role !== "mechanic") {
      window.location.href = "/customer";
      return;
    }
    document.getElementById("user-name").textContent = profile.full_name;
    document.getElementById("vehicle-types").textContent = (profile.vehicle_types || [])
      .join(", ")
      .toUpperCase();
  } catch {
    window.location.href = "/signup?complete=1";
    return;
  }

  await initMap();
  loadMyJobs();
  pollTimer = setInterval(loadPendingJobs, 5000);
});

async function initMap() {
  try {
    mechanicLocation = await getCurrentPosition();
  } catch {
    mechanicLocation = { lat: 19.076, lng: 72.8777 };
  }

  map = L.map("map").setView([mechanicLocation.lat, mechanicLocation.lng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  const mechanicIcon = L.divIcon({
    className: "mechanic-home-marker",
    html: `<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="14" fill="rgba(76,217,123,0.18)" stroke="rgba(76,217,123,1)" stroke-width="2"/><circle cx="16" cy="16" r="6" fill="rgba(76,217,123,1)"/></svg>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });

  mechanicMarker = L.marker([mechanicLocation.lat, mechanicLocation.lng], { icon: mechanicIcon }).addTo(map);
  mechanicMarker.bindPopup("<b>Your operational position</b>").openPopup();
}

async function onToggleOnline(e) {
  const alertEl = document.getElementById("status-alert");
  hideAlert(alertEl);

  const isOnline = e.target.checked;

  try {
    if (isOnline) {
      mechanicLocation = await getCurrentPosition();
      await apiFetch("/api/mechanic/status", {
        method: "PUT",
        body: JSON.stringify({
          is_online: true,
          lat: mechanicLocation.lat,
          lng: mechanicLocation.lng,
        }),
      });
      showAlert(alertEl, "Broadcast active. Incoming localized jobs will map below.", "success");
      loadPendingJobs();
    } else {
      await apiFetch("/api/mechanic/status", {
        method: "PUT",
        body: JSON.stringify({ is_online: false }),
      });
      document.getElementById("pending-list").innerHTML = "<p style='color:var(--text-dim); font-size:14px;'>Go online to receive live matching dispatch loops.</p>";
    }
  } catch (err) {
    e.target.checked = false;
    showAlert(alertEl, err.message);
  }
}

async function loadPendingJobs() {
  const toggle = document.getElementById("online-toggle");
  if (!toggle.checked) return;

  const list = document.getElementById("pending-list");
  try {
    const data = await apiFetch("/api/requests/pending");
    list.innerHTML = "";
    pendingMarkers.forEach((existingMarker) => existingMarker.remove());
    pendingMarkers = [];

    if (!data.requests.length) {
      list.innerHTML = "<p style='color:var(--text-dim); font-size:14px;'>No pending jobs nearby.</p>";
      return;
    }

    data.requests.forEach((req) => {
      const customer = req.profiles;
      if (map && Number.isFinite(req.lat) && Number.isFinite(req.lng)) {
        const jobMarker = L.marker([req.lat, req.lng])
          .addTo(map)
          .bindPopup(`<b>Request #${req.id}</b><br>${req.vehicle_type.toUpperCase()} · ${customer ? customer.full_name : "Customer"}`);
        pendingMarkers.push(jobMarker);
      }

      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <span class="${statusClass(req.status)}">${req.status}</span>
        <h4>${req.vehicle_type.toUpperCase()} · Issue #${req.id}</h4>
        <p style="margin:4px 0 6px 0;"><b>Description:</b> ${req.issue_description}</p>
        <p><b>Distress Origin:</b> ${customer ? customer.full_name : "Customer"} · Contact: ${customer ? customer.phone : "N/A"}</p>
        <button class="btn btn-primary btn-block accept-btn" style="width:100%; margin-top:12px;" data-id="${req.id}">Accept Emergency Route</button>
      `;
      list.appendChild(item);
    });

    list.querySelectorAll(".accept-btn").forEach((btn) => {
      btn.addEventListener("click", () => acceptJob(btn.dataset.id));
    });

    if (pendingMarkers.length) {
      const bounds = L.latLngBounds([mechanicLocation.lat, mechanicLocation.lng], pendingMarkers.map((markerItem) => markerItem.getLatLng()));
      map.fitBounds(bounds.pad(0.18));
    }
  } catch {
    list.innerHTML = "<p style='color:var(--error); font-size:13px;'>Could not parse incoming regional queues.</p>";
  }
}

async function acceptJob(requestId) {
  const alertEl = document.getElementById("status-alert");
  try {
    await apiFetch(`/api/requests/${requestId}/accept`, { method: "POST" });
    showAlert(alertEl, "Job assigned successfully! Initiate client contact coordinates.", "success");
    loadPendingJobs();
    loadMyJobs();
  } catch (err) {
    showAlert(alertEl, err.message);
  }
}

async function loadMyJobs() {
  const list = document.getElementById("my-jobs-list");
  try {
    const data = await apiFetch("/api/requests/mine");
    list.innerHTML = "";

    const active = (data.requests || []).filter((r) =>
      ["accepted", "in_progress"].includes(r.status)
    );

    if (!active.length) {
      list.innerHTML = "<p style='color:var(--text-dim); font-size:14px;'>No ongoing repair logs active.</p>";
      return;
    }

    active.forEach((req) => {
      const customer = req.profiles;
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <span class="${statusClass(req.status)}">${req.status}</span>
        <h4>${req.vehicle_type.toUpperCase()} · Ticket #${req.id}</h4>
        <p style="margin:4px 0;"><b>Client:</b> ${customer ? customer.full_name : "Customer"}</p>
        <p><b>Phone:</b> ${customer ? customer.phone : "N/A"}</p>
        <button class="btn btn-success btn-block complete-btn" style="width:100%; margin-top:12px;" data-id="${req.id}">Close Repair Order</button>
      `;
      list.appendChild(item);
    });

    list.querySelectorAll(".complete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await apiFetch(`/api/requests/${btn.dataset.id}/complete`, { method: "POST" });
        loadMyJobs();
      });
    });
  } catch {
    list.innerHTML = "<p style='color:var(--error); font-size:13px;'>Operational tracking logs error.</p>";
  }
}

window.addEventListener("beforeunload", () => {
  if (pollTimer) clearInterval(pollTimer);
});