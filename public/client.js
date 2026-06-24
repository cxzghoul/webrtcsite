const socket = io();
let localStream = null;
let isAdmin = false;
const peerConnections = {}; 
const pendingCandidates = {};

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

const videoElement = document.getElementById('remote-video');
const statusNode = document.getElementById('status-node');

function log(message, isError = false) {
    console.log(`[WebRTC] ${message}`);
    const panel = document.getElementById('debug-panel');
    if (!panel) return;
    
    const time = new Date().toLocaleTimeString();
    const color = isError ? '#ff4747' : '#00ff22';
    panel.innerHTML += `<span style="color: ${color}">[${time}] ${message}</span><br>`;
    panel.scrollTop = panel.scrollHeight;
}

// Проверка сессии при загрузке страницы (восстановление из LocalStorage)
window.addEventListener('DOMContentLoaded', () => {
    const savedSession = localStorage.getItem('stream_room_session');
    if (savedSession) {
        try {
            const session = JSON.parse(savedSession);
            log("Найдена сохраненная сессия. Автоматическое переподключение...");
            socket.emit('join_room', session);
        } catch(e) {
            localStorage.removeItem('stream_room_session');
        }
    } else {
        socket.emit('get_rooms');
    }
});

socket.on('rooms_list', (rooms) => {
    const list = document.getElementById('rooms-history');
    list.innerHTML = '';
    if (rooms.length === 0) {
        list.innerHTML = '<li style="cursor:default; background:transparent; justify-content:center; color: #667894;">Нет активных комнат</li>';
        return;
    }
    rooms.forEach(r => {
        const li = document.createElement('li');
        li.innerHTML = `<span># ${r.id}</span> <b>${r.isPublic ? 'Открытая' : 'Приватная'}</b>`;
        li.onclick = () => { document.getElementById('room-input').value = r.id; };
        list.appendChild(li);
    });
});

function joinRoom() {
    const roomId = document.getElementById('room-input').value.trim();
    const password = document.getElementById('pass-input').value;
    const nickname = document.getElementById('nick-input').value.trim();
    
    if (!roomId || !nickname) return alert('Пожалуйста, укажите название комнаты и ваш никнейм!');
    
    const sessionData = { roomId, password, nickname };
    
    // Сохраняем в localStorage для предотвращения вылета при перезагрузке
    localStorage.setItem('stream_room_session', JSON.stringify(sessionData));
    socket.emit('join_room', sessionData);
}

socket.on('init_role', ({ isAdmin: adminFlag, history }) => {
    isAdmin = adminFlag;
    
    document.getElementById('auth-screen').style.display = 'none';
    const mainContainer = document.getElementById('main-container');
    mainContainer.style.display = 'flex';
    setTimeout(() => mainContainer.style.opacity = '1', 50);
    
    // Очищаем старую консоль, если она была при переподключении
    const oldPanel = document.getElementById('debug-panel');
    if (oldPanel) oldPanel.remove();

    if (isAdmin) {
        document.getElementById('share-btn').style.display = 'block';
        document.getElementById('delete-btn').style.display = 'block';
        statusNode.textContent = "Режим: Организатор";
        
        // Создаем консоль отладки ТОЛЬКО для администратора
        const consoleDiv = document.createElement('div');
        consoleDiv.id = 'debug-panel';
        consoleDiv.className = 'admin-console';
        consoleDiv.innerHTML = '⚡ Консоль отладки администратора инициализирована...<br>';
        document.getElementById('video-section').appendChild(consoleDiv);
    } else {
        document.getElementById('share-btn').style.display = 'none';
        document.getElementById('delete-btn').style.display = 'none';
        statusNode.textContent = "Режим: Ожидание потока";
    }
    
    document.getElementById('chat-messages').innerHTML = '';
    history.forEach(appendMessage);
});

// --- СИГНАЛИНГ И WEB RTC ---
async function startScreenShare() {
    try {
        localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        videoElement.muted = true; 
        videoElement.srcObject = localStream;
        statusNode.textContent = "Трансляция активна";
        statusNode.classList.add('active');
        log("Медиапоток захвачен.");

        socket.emit('start_stream');
        localStream.getVideoTracks()[0].onended = () => stopStream();
    } catch (err) {
        log(`Ошибка захвата экрана: ${err.message}`, true);
    }
}

function deleteRoom() {
    if (confirm("Вы уверены, что хотите полностью удалить эту комнату? Все зрители будут отключены.")) {
        socket.emit('delete_current_room');
    }
}

function leaveRoom() {
    localStorage.removeItem('stream_room_session');
    location.reload();
}

socket.on('room_deleted_by_admin', () => {
    alert("Комната была удалена организатором.");
    localStorage.removeItem('stream_room_session');
    location.reload();
});

socket.on('viewer_joined', async ({ viewerId }) => {
    if (!localStream) return;
    try {
        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[viewerId] = pc;
        pendingCandidates[viewerId] = [];

        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc_signal', { to: viewerId, signal: { candidate: event.candidate } });
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc_signal', { to: viewerId, signal: { sdp: pc.localDescription } });
        log(`Сгенерирован Offer для зрителя ${viewerId}`);
    } catch (err) {
        log(`Ошибка WebRTC пира: ${err.message}`, true);
    }
});

socket.on('stream_started_on_server', ({ adminId }) => {
    if (isAdmin) return;
    log("Организатор запустил трансляцию.");
    initViewerConnection(adminId);
});

function initViewerConnection(adminId) {
    if (peerConnections[adminId]) return;
    try {
        videoElement.muted = false;
        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[adminId] = pc;
        pendingCandidates[adminId] = [];

        pc.ontrack = (event) => {
            videoElement.srcObject = event.streams[0];
            statusNode.textContent = "Просмотр стрима";
            statusNode.classList.add('active');
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc_signal', { to: adminId, signal: { candidate: event.candidate } });
            }
        };
    } catch (err) {
        console.error(err);
    }
}

socket.on('webrtc_signal', async ({ from, signal }) => {
    let pc = peerConnections[from];
    if (!pc && !isAdmin) {
        initViewerConnection(from);
        pc = peerConnections[from];
    }
    if (!pc) return;

    try {
        if (signal.sdp) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            if (signal.sdp.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit('webrtc_signal', { to: from, signal: { sdp: pc.localDescription } });
            }
            if (pendingCandidates[from]) {
                for (const candidate of pendingCandidates[from]) {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }
                pendingCandidates[from] = [];
            }
        } else if (signal.candidate) {
            if (pc.remoteDescription && pc.remoteDescription.type) {
                await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } else {
                pendingCandidates[from].push(signal.candidate);
            }
        }
    } catch (err) {
         log(`Ошибка обработки сигналов WebRTC: ${err.message}`, true);
    }
});

socket.on('stream_stopped_on_server', () => {
    videoElement.srcObject = null;
    statusNode.textContent = isAdmin ? "Режим: Организатор" : "Режим: Ожидание потока";
    statusNode.classList.remove('active');
    closeAllConnections();
});

function stopStream() {
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    socket.emit('stop_stream');
    videoElement.srcObject = null;
    statusNode.classList.remove('active');
    closeAllConnections();
}

function closeAllConnections() {
    Object.keys(peerConnections).forEach(id => {
        peerConnections[id].close();
        delete peerConnections[id];
        delete pendingCandidates[id];
    });
}

socket.on('error_msg', msg => {
    alert(msg);
    localStorage.removeItem('stream_room_session');
    location.reload();
});

// Чат
function sendMessage() {
    const input = document.getElementById('msg-input');
    if (!input.value.trim()) return;
    socket.emit('send_msg', input.value.trim());
    input.value = '';
}

socket.on('receive_msg', appendMessage);
socket.on('sys_message', (text) => appendMessage({ nickname: 'Система', text, isSystem: true }));

function appendMessage({ nickname, text, time, isSystem }) {
    const chat = document.getElementById('chat-messages');
    const div = document.createElement('div');
    if (isSystem) { 
        div.className = 'msg system'; div.textContent = `• ${text}`; 
    } else {
        div.className = 'msg';
        const displayTime = time || new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        div.innerHTML = `<div class="msg-meta"><span class="nick">${nickname}</span><span class="time">${displayTime}</span></div><div class="text">${escapeHTML(text)}</div>`;
    }
    chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
}

function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}