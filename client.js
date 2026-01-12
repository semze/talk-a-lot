// client.js — WebRTC + Firebase Realtime DB signaling (suitable for GitHub Pages)
// IMPORTANT: Replace the firebaseConfig placeholder below with your Firebase project's config.

///// Firebase config - replace with your project's config /////
const firebaseConfig = {
  apiKey: "REPLACE_WITH_YOUR_API_KEY",
  authDomain: "REPLACE_WITH_YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://REPLACE_WITH_YOUR_PROJECT.firebaseio.com",
  projectId: "REPLACE_WITH_YOUR_PROJECT",
  storageBucket: "REPLACE_WITH_YOUR_PROJECT.appspot.com",
  messagingSenderId: "SENDER_ID",
  appId: "APP_ID"
};
/////////////////////////////////////////////////////////////////////

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const logEl = document.getElementById('log');
function log(...args) {
  console.log(...args);
  logEl.textContent += args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const roomInput = document.getElementById('room');
const status = document.getElementById('status');
const peerList = document.getElementById('peerList');

let localStream = null;
let roomId = null;
const localId = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
const pcs = {}; // remoteId -> RTCPeerConnection
const candidateListeners = {}; // remoteId -> { ref, offHandler } for cleanup
const signalListeners = { ref: null, childAddedHandler: null };

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
    // For better NAT traversal, add TURN servers here:
    // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
  ]
};

function setStatus(s) { status.textContent = s; }

async function joinRoom() {
  if (!roomInput.value) return alert('Enter a room name');
  roomId = roomInput.value.trim();
  setStatus('Requesting microphone...');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setStatus('Microphone access denied or unavailable: ' + e.message);
    log('getUserMedia error', e);
    return;
  }

  setStatus('Joined room (creating presence) — id: ' + localId);
  joinBtn.disabled = true;
  leaveBtn.disabled = false;

  // add self to /rooms/<roomId>/peers/<localId> with a timestamp
  const peerRef = db.ref(`rooms/${roomId}/peers/${localId}`);
  await peerRef.set({ t: firebase.database.ServerValue.TIMESTAMP });
  // ensure removal on disconnect
  peerRef.onDisconnect().remove();

  // Listen for existing peers (one-time) and create offers to them
  const peersSnap = await db.ref(`rooms/${roomId}/peers`).once('value');
  const peers = peersSnap.val() || {};
  Object.keys(peers).forEach(pid => {
    if (pid === localId) return;
    addPeerUI(pid);
    // existing peers are already present — create offer to each
    createOffer(pid).catch(e => log('createOffer error', e));
  });

  // Listen for signals directed to us (offers or answers)
  const signalsPath = `rooms/${roomId}/signals/${localId}`;
  const signalsRef = db.ref(signalsPath);
  signalListeners.ref = signalsRef;
  signalListeners.childAddedHandler = signalsRef.on('child_added', async snap => {
    const fromId = snap.key; // sender id
    const data = snap.val();
    if (!data) return;
    // data may have structure { offer: {...} } or { answer: {...} }
    if (data.offer) {
      log('Received offer from', fromId);
      addPeerUI(fromId);
      const pc = await ensurePC(fromId);
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      // write answer to the sender's signals area
      const toRef = db.ref(`rooms/${roomId}/signals/${fromId}/${localId}`);
      await toRef.set({ answer: pc.localDescription });
    } else if (data.answer) {
      log('Received answer from', fromId);
      const pc = pcs[fromId];
      if (!pc) return log('No pc for', fromId);
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    }
  });

  // Listen for candidates addressed to us
  const candidatesPath = `rooms/${roomId}/candidates/${localId}`;
  const candidatesRef = db.ref(candidatesPath);
  // When a child (fromId) is added, attach a listener for its children (actual candidate entries)
  candidatesRef.on('child_added', snap => {
    const fromId = snap.key;
    const perFromRef = db.ref(`${candidatesPath}/${fromId}`);
    // store so we can detach later
    candidateListeners[fromId] = { ref: perFromRef };
    perFromRef.on('child_added', childSnap => {
      const cand = childSnap.val();
      log('Received ICE candidate from', fromId, cand);
      const pc = pcs[fromId];
      if (pc) {
        try {
          pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {
          log('addIceCandidate error', e);
        }
      } else {
        log('No pc yet for candidate from', fromId);
      }
    });
  });

  // Watch for peers leaving (optional: update UI). We'll watch the peers list.
  db.ref(`rooms/${roomId}/peers`).on('child_removed', snap => {
    const pid = snap.key;
    log('peer removed', pid);
    removePeerUI(pid);
    closePeer(pid);
  });

  setStatus('Ready — local id: ' + localId);
}

function addPeerUI(peerId) {
  if (document.getElementById('peer-' + peerId)) return;
  const div = document.createElement('div');
  div.className = 'peer';
  div.id = 'peer-' + peerId;
  div.textContent = 'Peer: ' + peerId;
  document.getElementById('peerList').appendChild(div);
}

function removePeerUI(peerId) {
  const el = document.getElementById('peer-' + peerId);
  if (el) el.remove();
  const audioEl = document.getElementById('audio-' + peerId);
  if (audioEl) audioEl.remove();
}

async function createOffer(remoteId) {
  log('Creating offer to', remoteId);
  const pc = await ensurePC(remoteId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // write offer into /rooms/<roomId>/signals/<remoteId>/<localId>
  const targetRef = db.ref(`rooms/${roomId}/signals/${remoteId}/${localId}`);
  await targetRef.set({ offer: pc.localDescription });
}

function closePeer(peerId) {
  const pc = pcs[peerId];
  if (pc) {
    try { pc.close(); } catch (e) {}
    delete pcs[peerId];
  }
  // cleanup candidate listeners
  if (candidateListeners[peerId]) {
    try {
      candidateListeners[peerId].ref.off();
    } catch(e){}
    delete candidateListeners[peerId];
  }
}

async function ensurePC(remoteId) {
  if (pcs[remoteId]) return pcs[remoteId];
  const pc = new RTCPeerConnection(rtcConfig);
  pcs[remoteId] = pc;

  // add local audio
  if (localStream) {
    for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
  }

  // remote track -> audio element
  pc.ontrack = ev => {
    log('ontrack from', remoteId, ev.streams);
    let audioEl = document.getElementById('audio-' + remoteId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = 'audio-' + remoteId;
      audioEl.autoplay = true;
      audioEl.controls = false;
      document.getElementById('peerList').appendChild(audioEl);
    }
    audioEl.srcObject = ev.streams[0];
  };

  pc.onicecandidate = ev => {
    if (!ev.candidate) return;
    const cand = ev.candidate.toJSON();
    log('Local ICE candidate for', remoteId, cand);
    // write candidate to /rooms/<roomId>/candidates/<remoteId>/<localId>/{pushId}
    const candRef = db.ref(`rooms/${roomId}/candidates/${remoteId}/${localId}`).push();
    candRef.set(cand);
  };

  pc.onconnectionstatechange = () => {
    log('connectionState', remoteId, pc.connectionState);
  };

  return pc;
}

async function leaveRoom() {
  if (!roomId) return;
  // Remove presence
  try {
    await db.ref(`rooms/${roomId}/peers/${localId}`).remove();
  } catch(e){ log('remove presence error', e); }

  // Remove any signals we created under others (optional cleanup)
  // Note: this static-hosted, client-only cleanup may not remove everything if clients die unexpectedly.

  // Detach listeners
  if (signalListeners.ref && signalListeners.childAddedHandler) {
    signalListeners.ref.off('child_added', signalListeners.childAddedHandler);
  }
  if (signalListeners.ref) {
    signalListeners.ref.remove();
  }
  if (candidateListeners) {
    Object.values(candidateListeners).forEach(obj => {
      try { obj.ref.off(); } catch(e) {}
    });
  }

  // Close peer connections
  Object.keys(pcs).forEach(pid => closePeer(pid));

  // Stop local mic
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  roomId = null;
  joinBtn.disabled = false;
  leaveBtn.disabled = true;
  setStatus('Left room');
  peerList.innerHTML = '';
  log('left room');
}

// Button handlers
joinBtn.onclick = () => joinRoom();
leaveBtn.onclick = () => leaveRoom();

// Cleanup on page unload: remove presence
window.addEventListener('beforeunload', () => {
  if (roomId) {
    try { db.ref(`rooms/${roomId}/peers/${localId}`).remove(); } catch(e) {}
  }
});
