const socket = io();
let localStream = null;
let isAdmin = false;
let currentUsername = "";
const peerConnections = {}; 
const pendingCandidates = {};

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

let isRegisterMode = false;
const videoElement = document.getElementById('remote-video');
const statusNode = document.getElementById('status-node');

// Вывод логов ТОЛЬКО в случае, если панель существует на экране (то есть у админа)
function log(message, isError = false) {
    console.log(`[WebRTC] ${message}`);
    const panel = document.getElementById('debug-panel');
    if (!panel) return; 
    
    const time = new Date().toLocaleTimeString();
    const color = isError ? '#ff4747' : '#00ff22';
    panel.innerHTML += `<span style="color: ${color}">[${time}] ${message}</span><br>`;
    panel.scrollTop = panel.scrollHeight;
}

// --- ЛОГИКА АУТЕНТИФИКАЦИИ ---
function toggleAuthMode() {
    isRegisterMode = !isRegisterMode;
    document.getElementById('auth-title').textContent = isRegisterMode ? "Регистрация" : "Авторизация";
    document.getElementById('auth-desc').textContent = isRegisterMode ? "Создайте новую учетную запись" : "Введите свои данные для доступа к платформе";
    document.getElementById('auth-submit-btn').textContent = isRegisterMode ? "Зарегистрироваться" : "Войти в аккаунт";
    document.getElementById('auth-toggle-mode').innerHTML = isRegisterMode ? "Уже есть аккаунт? <span>Войти</span>" : "Еще нет аккаунта? <span>Регистрация</span>";
}

function handleAuthSubmit() {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value.trim();
    
    if(!username || !password) return alert("Заполните все поля поля аккаунта!");
    
    const eventName = isRegisterMode ? "account_register" : "account_login";
    socket.emit(eventName, { username, password });
}

socket.on('auth_success', ({ username }) => {
    currentUsername = username;
    document.getElementById('credentials-section').style.display = 'none';
    document.getElementById('room-select-section').style.display = 'block';
    document.getElementById('user-greeting').textContent = username;
    
    // Подгружаем историю и глобальный список комнат
    renderVisitedRooms();
    socket.emit('get_rooms');
});

// --- СЕРВЕРНЫЙ СПИСОК И ИСТОРИЯ ПОСЕЩЕНИЙ ---
socket.on('rooms_list', (rooms) => {
    const list = document.getElementById('public-rooms');
    list.innerHTML = '';
    if (rooms.length === 0) {
        list.innerHTML = '<li style="color:#667894; justify-content:center; background:transparent;">Нет активных комнат</li>';
        return;
    }
    rooms.forEach(r => {
        const li = document.createElement('li');
        li.innerHTML = `<span># ${r.id}</span> <b>${r.isPublic ? 'Открытая' : 'Приватная'}</b>`;
        li.onclick = () => { document.getElementById('room-id-input').value = r.id; };
        list.appendChild(li);
    });
});

function saveVisitedRoom(roomId) {
    let visited = JSON.parse(localStorage.getItem(`visited_${currentUsername}`)) || [];
    if (!visited.includes(roomId)) {
        visited.push(roomId);
        if(visited.length > 5) visited.shift(); // Хранить максимум 5 комнат
        localStorage.setItem(`visited_${currentUsername}`, JSON.stringify(visited));
    }
}

function renderVisitedRooms() {
    const list = document.getElementById('rooms-history');
    list.innerHTML = '';
    let visited = JSON.parse(localStorage.getItem(`visited_${currentUsername}`)) || [];
    if(visited.length === 0) {
        list.innerHTML = '<li style="color:#667894; justify-content:center; background:transparent;">Список пуст</li>';
        return;
    }
    visited.reverse().forEach(roomId => {
        const li = document.createElement('li');
        li.innerHTML = `<span># ${roomId}</span>`;
        li.onclick = () => { document.getElementById('room-id-input').value = roomId; };
        list.appendChild(li);
    });
}

function handleJoinRoom() {
    const roomId = document.getElementById('room-id-input').value.trim();
    const password = document.getElementById('room-pass-input').value;
    if (!roomId) return alert('Укажите ID комнаты!');
    
    socket.emit('join_room', { roomId, password });
}

// --- ИНИЦИАЛИЗАЦИЯ ИНТЕРФЕЙСА КОМНАТЫ ---
socket.on('init_role', ({ isAdmin: adminFlag, history, roomId }) => {
    isAdmin = adminFlag;
    saveVisitedRoom(roomId);
    
    document.getElementById('auth-screen').style.display = 'none';
    const mainContainer = document.getElementById('main-container');
    mainContainer.style.display = 'flex';
    setTimeout(() => mainContainer.style.opacity = '1', 50);
    
    // Удаляем старую консоль, если она была
    const oldPanel = document.getElementById('debug-panel');
    if(oldPanel) oldPanel.remove();

    if (isAdmin) {
        document.getElementById('share-btn').style.display = 'block';
        document.getElementById('delete-btn').style.display = 'block'; // Показываем кнопку удаления создателю
        statusNode.textContent = "Режим: Организатор";
        
        // ДИНАМИЧЕСКИ создаем консоль отладки только админу
        const consoleDiv = document.createElement('div');
        consoleDiv.id = 'debug-panel';
        consoleDiv.className = 'admin-console';
        consoleDiv.innerHTML = '⚡ Инициализирована консоль администратора...<br>';
        document.getElementById('video-section').appendChild(consoleDiv);
    } else {
        document.getElementById('share-btn').style.display = 'none';
        document.getElementById('delete-btn').style.display = 'none';
        statusNode.textContent = "Режим: Ожидание потока";
    }
    
    document.getElementById('chat-messages').innerHTML = '';
    history.forEach(appendMessage);
});

// --- СИГНАЛИНГ И РАБОТА С СЕТЬЮ ---
async function startScreenShare() {
    try {
        localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        videoElement.muted = true; 
        videoElement.srcObject = localStream;
        statusNode.textContent = "Трансляция активна";
        statusNode.classList.add('active');
        log("Экран успешно захвачен локально.");

        socket.emit('start_stream');
        localStream.getVideoTracks()[0].onended = () => stopStream();
    } catch (err) {
        log(`Ошибка захвата экрана: ${err.message}`, true);
    }
}

function deleteRoom() {
    if(confirm("Вы действительно хотите полностью удалить эту комнату? Все участники будут исключены.")) {
        socket.emit('delete_current_room');
    }
}

socket.on('room_deleted_by_admin', () => {
    alert("Комната была удалена создателем.");
    location.reload(); // Перезагружаем страницу для сброса всех RTC-состояний
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
        log(`Отправлен Offer зрителю ${viewerId}`);
    } catch (err) {
        log(`Ошибка построения пира: ${err.message}`, true);
    }
});

socket.on('stream_started_on_server', ({ adminId }) => {
    if (isAdmin) return;
    log("Админ начал вещание.");
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
            statusNode.textContent = "Просмотр трансляции";
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
         log(`Ошибка WebRTC: ${err.message}`, true);
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

socket.on('error_msg', msg => alert(msg));

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