const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Хранилища в ОЗУ (Обнуляются при перезапуске сервера)
const users = {}; 
const rooms = {}; 

function getPublicRooms() {
    return Object.keys(rooms).map(id => ({
        id,
        isPublic: !rooms[id].password
    }));
}

io.on('connection', (socket) => {
    let authUser = null;
    let currentRoom = null;

    // --- АККАУНТЫ ---
    socket.on('account_register', ({ username, password }) => {
        const uName = username.trim();
        if(!uName || !password) return socket.emit('error_msg', 'Недопустимые поля!');
        if(users[uName]) return socket.emit('error_msg', 'Пользователь уже существует!');
        
        users[uName] = { password }; // Простейшее сохранение пароля
        socket.emit('error_msg', 'Регистрация успешна! Теперь войдите.');
    });

    socket.on('account_login', ({ username, password }) => {
        const uName = username.trim();
        if(!users[uName] || users[uName].password !== password) {
            return socket.emit('error_msg', 'Неверное имя пользователя или пароль!');
        }
        authUser = uName;
        socket.emit('auth_success', { username: uName });
    });

    // --- КОМНАТЫ ---
    socket.on('join_room', ({ roomId, password }) => {
        if (!authUser) return socket.emit('error_msg', 'Сначала авторизуйтесь!');
        if (!roomId || !roomId.trim()) return socket.emit('error_msg', 'Неверный ID комнаты');

        roomId = roomId.trim();

        // Создание, если нет
        if (!rooms[roomId]) {
            rooms[roomId] = {
                password: password && password.trim() !== "" ? password.trim() : null,
                messages: [],
                admin: socket.id,
                streamActive: false
            };
        }

        if (rooms[roomId].password && rooms[roomId].password !== password?.trim()) {
            return socket.emit('error_msg', 'Доступ запрещен: Неверный пароль!');
        }

        currentRoom = roomId;
        socket.join(roomId);

        socket.emit('init_role', { 
            isAdmin: rooms[roomId].admin === socket.id,
            history: rooms[roomId].messages,
            roomId: roomId
        });

        io.to(roomId).emit('sys_message', `${authUser} зашел на трансляцию.`);
        
        if (rooms[roomId].streamActive && rooms[roomId].admin !== socket.id) {
            io.to(rooms[roomId].admin).emit('viewer_joined', { viewerId: socket.id });
        }

        io.emit('rooms_list', getPublicRooms());
    });

    socket.on('start_stream', () => {
        if (!currentRoom || !rooms[currentRoom] || rooms[currentRoom].admin !== socket.id) return;
        rooms[currentRoom].streamActive = true;
        socket.to(currentRoom).emit('stream_started_on_server', { adminId: socket.id });
    });

    socket.on('stop_stream', () => {
        if (!currentRoom || !rooms[currentRoom] || rooms[currentRoom].admin !== socket.id) return;
        rooms[currentRoom].streamActive = false;
        socket.to(currentRoom).emit('stream_stopped_on_server');
    });

    // Удаление комнаты создателем
    socket.on('delete_current_room', () => {
        if (!currentRoom || !rooms[currentRoom]) return;
        if (rooms[currentRoom].admin !== socket.id) return socket.emit('error_msg', 'У вас нет прав!');

        // Извещаем всех в комнате о деструктуризации комнаты
        io.to(currentRoom).emit('room_deleted_by_admin');
        
        delete rooms[currentRoom];
        io.emit('rooms_list', getPublicRooms());
    });

    socket.on('webrtc_signal', ({ to, signal }) => {
        io.to(to).emit('webrtc_signal', { from: socket.id, signal });
    });

    socket.on('send_msg', (text) => {
        if (!currentRoom || !rooms[currentRoom] || !authUser) return;
        const msgData = { 
            nickname: authUser, 
            text, 
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) 
        };
        rooms[currentRoom].messages.push(msgData);
        io.to(currentRoom).emit('receive_msg', msgData);
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            io.to(currentRoom).emit('sys_message', `${authUser || 'Аноним'} покинул комнату.`);
            
            // Если админ просто закрыл вкладку, комната также уничтожается для безопасности
            if (rooms[currentRoom].admin === socket.id) {
                io.to(currentRoom).emit('room_deleted_by_admin');
                delete rooms[currentRoom];
                io.emit('rooms_list', getPublicRooms());
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));