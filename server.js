const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = report = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {}; 

function getPublicRooms() {
    return Object.keys(rooms).map(id => ({
        id,
        isPublic: !rooms[id].password
    }));
}

io.on('connection', (socket) => {
    let currentRoom = null;
    let userNickname = 'Аноним';

    socket.on('get_rooms', () => {
        socket.emit('rooms_list', getPublicRooms());
    });

    socket.on('join_room', ({ roomId, password, nickname }) => {
        if (!roomId || !roomId.trim() || !nickname || !nickname.trim()) {
            return socket.emit('error_msg', 'Название комнаты и никнейм обязательны!');
        }

        roomId = roomId.trim();
        userNickname = nickname.trim();

        // Если комнаты нет - создаем её, а текущий сокет назначаем админом
        if (!rooms[roomId]) {
            rooms[roomId] = {
                password: password && password.trim() !== "" ? password.trim() : null,
                messages: [],
                admin: socket.id,
                streamActive: false
            };
        } else {
            // Если комната существует и имеет пароль, проверяем его
            if (rooms[roomId].password && rooms[roomId].password !== password?.trim()) {
                return socket.emit('error_msg', 'Неверный пароль доступа к комнате!');
            }
        }

        currentRoom = roomId;
        socket.join(roomId);

        // Инициализируем роль на клиенте
        socket.emit('init_role', { 
            isAdmin: rooms[roomId].admin === socket.id,
            history: rooms[roomId].messages
        });

        io.to(roomId).emit('sys_message', `${userNickname} присоединился к комнате.`);
        
        // Если трансляция уже идет, просим админа создать offer для нового зрителя
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

    // Полное удаление комнаты создателем
    socket.on('delete_current_room', () => {
        if (!currentRoom || !rooms[currentRoom] || rooms[currentRoom].admin !== socket.id) return;

        io.to(currentRoom).emit('room_deleted_by_admin');
        delete rooms[currentRoom];
        io.emit('rooms_list', getPublicRooms());
    });

    socket.on('webrtc_signal', ({ to, signal }) => {
        io.to(to).emit('webrtc_signal', { from: socket.id, signal });
    });

    socket.on('send_msg', (text) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const msgData = { 
            nickname: userNickname, 
            text: text.trim(), 
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
        };
        rooms[currentRoom].messages.push(msgData);
        if (rooms[currentRoom].messages.length > 50) rooms[currentRoom].messages.shift();

        io.to(currentRoom).emit('receive_msg', msgData);
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            io.to(currentRoom).emit('sys_message', `${userNickname} покинул комнату.`);
            
            // Если комнату покинул админ (закрыл вкладку), удаляем комнату, чтобы сессия не зависала
            if (rooms[currentRoom].admin === socket.id) {
                io.to(currentRoom).emit('room_deleted_by_admin');
                delete rooms[currentRoom];
                io.emit('rooms_list', getPublicRooms());
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Элегантный сервер на: http://localhost:${PORT}`));