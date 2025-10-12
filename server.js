const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 11;
const SKILLS = ['飞沙走石', '力拔山兮', '静如止水', '调呈离山', '时光倒流', '拾金不昧'];
const SKILL_DESCRIPTIONS = {
    '飞沙走石': '移除对手任意一枚棋子，并封锁该落点使其下一回合无法落子。',
    '力拔山兮': '掀翻棋盘，棋盘上当前的棋子随机掉落一半。',
    '静如止水': '冻结时间，使对手失去一回合落子机会。',
    '调呈离山': '强制将对手棋子移动到棋盘边缘的冷宫区，该区域棋子无法参与连珠。',
    '时光倒流': '将棋局重置回3步之前的状态，双方棋子位置恢复。',
    '拾金不昧': '随机与对手交换一枚棋子，包括已连成线的棋子。'
};
const NEXT_STEP = {
    '飞沙走石': '请选择要移除的对手棋子。',
    '力拔山兮': '请点击棋盘任意位置发动技能，棋子将随机掉落。',
    '静如止水': '请点击棋盘任意位置发动技能，冻结对手的下一回合。',
    '调呈离山': '请选择要移动到冷宫区的对手棋子。',
    '时光倒流': '请点击棋盘任意位置回退到3步之前。',
    '拾金不昧': '请点击棋盘任意位置随机交换一枚棋子。'
};

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let clientCounter = 0;
const clients = new Map(); // ws -> client
const waitingQueue = []; // array of client
const rooms = new Map(); // roomId -> room

wss.on('connection', (ws) => {
    const client = {
        id: ++clientCounter,
        ws,
        username: null,
        queueing: false,
        roomId: null,
        playerNumber: null
    };
    clients.set(ws, client);

    ws.on('message', (raw) => {
        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch (err) {
            console.error('Invalid message', raw.toString());
            return;
        }
        handleClientMessage(client, message);
    });

    ws.on('close', () => {
        handleDisconnect(client);
        clients.delete(ws);
    });
});

function handleClientMessage(client, message) {
    switch (message.type) {
        case 'login':
            handleLogin(client, message.username);
            break;
        case 'find_match':
            handleFindMatch(client);
            break;
        case 'cancel_queue':
            cancelQueue(client);
            break;
        case 'activate_skill':
            handleActivateSkill(client, message);
            break;
        case 'board_click':
            handleBoardClick(client, message);
            break;
        case 'restart':
            handleRestart(client);
            break;
        default:
            send(client.ws, { type: 'error', message: '未知的指令类型。' });
    }
}

function handleLogin(client, username) {
    if (!username || typeof username !== 'string' || !username.trim()) {
        send(client.ws, { type: 'error', message: '昵称不能为空。' });
        return;
    }
    if (username.length > 16) {
        send(client.ws, { type: 'error', message: '昵称长度不能超过 16 个字符。' });
        return;
    }
    client.username = username.trim();
    send(client.ws, { type: 'login_success', username: client.username });
}

function handleFindMatch(client) {
    if (!client.username) {
        send(client.ws, { type: 'error', message: '请先登录后再匹配。' });
        return;
    }
    if (client.roomId) {
        send(client.ws, { type: 'error', message: '您正在对局中。' });
        return;
    }
    if (client.queueing) {
        return;
    }
    client.queueing = true;
    waitingQueue.push(client);
    send(client.ws, { type: 'queue_update', status: 'queued' });
    attemptMatch();
}

function cancelQueue(client) {
    if (!client.queueing) return;
    client.queueing = false;
    const idx = waitingQueue.indexOf(client);
    if (idx >= 0) {
        waitingQueue.splice(idx, 1);
    }
    send(client.ws, { type: 'queue_update', status: 'cancelled' });
}

function attemptMatch() {
    while (waitingQueue.length >= 2) {
        const playerA = waitingQueue.shift();
        const playerB = waitingQueue.shift();
        if (!playerA || !playerB) {
            continue;
        }
        playerA.queueing = false;
        playerB.queueing = false;
        createRoom(playerA, playerB);
    }
}

function createRoom(clientA, clientB) {
    const roomId = `room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const players = [clientA, clientB];
    if (Math.random() < 0.5) {
        players.reverse();
    }
    const room = {
        id: roomId,
        clients: {
            1: players[0],
            2: players[1]
        },
        state: createGameState({
            1: { username: players[0].username },
            2: { username: players[1].username }
        })
    };
    rooms.set(roomId, room);

    players.forEach((client, index) => {
        const playerNumber = index + 1;
        client.roomId = roomId;
        client.playerNumber = playerNumber;
        send(client.ws, {
            type: 'match_found',
            roomId,
            playerNumber,
            players: room.state.players,
            state: serializeState(room.state)
        });
    });
}

function handleActivateSkill(client, message) {
    const room = rooms.get(client.roomId);
    if (!room) return;
    const playerNumber = client.playerNumber;
    if (!playerNumber) return;
    const skill = message.skill;
    if (!SKILLS.includes(skill)) {
        send(client.ws, { type: 'error', message: '未知技能。' });
        return;
    }
    const state = room.state;
    if (state.winner) {
        return;
    }
    if (state.currentPlayer !== playerNumber) {
        send(client.ws, { type: 'error', message: '未轮到你行动。' });
        return;
    }
    if (state.skillActive[playerNumber]) {
        send(client.ws, { type: 'error', message: '请先完成当前技能。' });
        return;
    }
    if (state.skillUsed[playerNumber][skill]) {
        send(client.ws, { type: 'error', message: '技能已使用。' });
        return;
    }
    state.skillActive[playerNumber] = skill;
    state.status = `${playerName(state, playerNumber)}选择了技能 ${skill}：${SKILL_DESCRIPTIONS[skill]} ${NEXT_STEP[skill]}`;
    broadcastState(room);
}

function handleBoardClick(client, message) {
    const room = rooms.get(client.roomId);
    if (!room) return;
    const state = room.state;
    const playerNumber = client.playerNumber;
    if (!playerNumber || state.winner) return;
    if (state.currentPlayer !== playerNumber) return;

    const row = Number(message.row);
    const col = Number(message.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
        return;
    }

    if (state.skipNextTurn[playerNumber]) {
        state.skipNextTurn[playerNumber] = false;
        state.currentPlayer = opponentOf(playerNumber);
        state.status = `${playerName(state, state.currentPlayer)}落子`;
        broadcastState(room);
        return;
    }

    for (const key of Object.keys(state.blockedPositions)) {
        if (state.blockedPositions[key] === playerNumber) {
            delete state.blockedPositions[key];
        }
    }

    const skill = state.skillActive[playerNumber];
    if (skill) {
        executeSkill(state, playerNumber, skill, row, col);
        broadcastState(room);
        return;
    }

    const key = `${row},${col}`;
    if (state.board[row][col] !== 0) {
        return;
    }
    if (state.blockedPositions[key] === playerNumber) {
        return;
    }
    state.board[row][col] = playerNumber;
    state.moves.push({ row, col, player: playerNumber });

    if (checkWin(state, playerNumber, row, col)) {
        state.winner = playerNumber;
        state.status = `${playerName(state, playerNumber)}胜利！`;
    } else {
        state.currentPlayer = opponentOf(playerNumber);
        state.status = `${playerName(state, state.currentPlayer)}落子`;
    }
    broadcastState(room);
}

function handleRestart(client) {
    const room = rooms.get(client.roomId);
    if (!room) return;
    room.state = createGameState(room.state.players);
    broadcastState(room);
}

function executeSkill(state, playerNumber, skill, row, col) {
    const opponent = opponentOf(playerNumber);
    switch (skill) {
        case '飞沙走石': {
            if (state.board[row][col] === opponent) {
                state.blockedPositions[`${row},${col}`] = opponent;
                state.board[row][col] = 0;
                delete state.coldPalacePositions[`${row},${col}`];
                removeMove(state, row, col);
            }
            state.skillUsed[playerNumber]['飞沙走石'] = true;
            state.skillActive[playerNumber] = null;
            state.currentPlayer = opponent;
            state.status = `${playerName(state, state.currentPlayer)}落子`;
            break;
        }
        case '力拔山兮': {
            for (let r = 0; r < BOARD_SIZE; r++) {
                for (let c = 0; c < BOARD_SIZE; c++) {
                    if (state.board[r][c] !== 0 && Math.random() < 0.5) {
                        state.board[r][c] = 0;
                        delete state.coldPalacePositions[`${r},${c}`];
                        removeMove(state, r, c);
                    }
                }
            }
            state.skillUsed[playerNumber]['力拔山兮'] = true;
            state.skillActive[playerNumber] = null;
            state.currentPlayer = opponent;
            state.status = `${playerName(state, state.currentPlayer)}落子`;
            break;
        }
        case '静如止水': {
            state.skipNextTurn[opponent] = true;
            state.skillUsed[playerNumber]['静如止水'] = true;
            state.skillActive[playerNumber] = null;
            state.currentPlayer = opponent;
            state.status = `${playerName(state, state.currentPlayer)}落子`;
            break;
        }
        case '调呈离山': {
            if (state.board[row][col] === opponent) {
                const edges = [];
                for (let r = 0; r < BOARD_SIZE; r++) {
                    for (let c = 0; c < BOARD_SIZE; c++) {
                        if (r === 0 || c === 0 || r === BOARD_SIZE - 1 || c === BOARD_SIZE - 1) {
                            if (state.board[r][c] === 0) {
                                edges.push({ r, c });
                            }
                        }
                    }
                }
                if (edges.length > 0) {
                    const idx = Math.floor(Math.random() * edges.length);
                    const target = edges[idx];
                    state.board[row][col] = 0;
                    delete state.coldPalacePositions[`${row},${col}`];
                    removeMove(state, row, col);
                    state.board[target.r][target.c] = opponent;
                    state.coldPalacePositions[`${target.r},${target.c}`] = true;
                    state.moves.push({ row: target.r, col: target.c, player: opponent });
                }
            }
            state.skillUsed[playerNumber]['调呈离山'] = true;
            state.skillActive[playerNumber] = null;
            state.currentPlayer = opponent;
            state.status = `${playerName(state, state.currentPlayer)}落子`;
            break;
        }
        case '时光倒流': {
            let removed = 0;
            while (state.moves.length > 0 && removed < 3) {
                const lastMove = state.moves.pop();
                state.board[lastMove.row][lastMove.col] = 0;
                delete state.coldPalacePositions[`${lastMove.row},${lastMove.col}`];
                removed++;
            }
            state.skillUsed[playerNumber]['时光倒流'] = true;
            state.skillActive[playerNumber] = null;
            if (state.moves.length === 0) {
                state.currentPlayer = 1;
            } else {
                const lastMove = state.moves[state.moves.length - 1];
                state.currentPlayer = opponentOf(lastMove.player);
            }
            state.status = `${playerName(state, state.currentPlayer)}落子`;
            state.winner = null;
            break;
        }
        case '拾金不昧': {
            const currentPieces = [];
            const opponentPieces = [];
            for (let r = 0; r < BOARD_SIZE; r++) {
                for (let c = 0; c < BOARD_SIZE; c++) {
                    if (state.board[r][c] === playerNumber) currentPieces.push({ r, c });
                    if (state.board[r][c] === opponent) opponentPieces.push({ r, c });
                }
            }
            if (currentPieces.length > 0 && opponentPieces.length > 0) {
                const cp = currentPieces[Math.floor(Math.random() * currentPieces.length)];
                const op = opponentPieces[Math.floor(Math.random() * opponentPieces.length)];
                const cpKey = `${cp.r},${cp.c}`;
                const opKey = `${op.r},${op.c}`;
                const cpCold = !!state.coldPalacePositions[cpKey];
                const opCold = !!state.coldPalacePositions[opKey];
                state.board[cp.r][cp.c] = opponent;
                state.board[op.r][op.c] = playerNumber;
                delete state.coldPalacePositions[cpKey];
                delete state.coldPalacePositions[opKey];
                if (cpCold) {
                    state.coldPalacePositions[opKey] = true;
                }
                if (opCold) {
                    state.coldPalacePositions[cpKey] = true;
                }
                swapMoveOwner(state, cp.r, cp.c, opponent);
                swapMoveOwner(state, op.r, op.c, playerNumber);
            }
            state.skillUsed[playerNumber]['拾金不昧'] = true;
            state.skillActive[playerNumber] = null;
            state.currentPlayer = opponent;
            state.status = `${playerName(state, state.currentPlayer)}落子`;
            break;
        }
    }
}

function createGameState(players) {
    const board = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
        const row = new Array(BOARD_SIZE).fill(0);
        board.push(row);
    }
    const playerInfo = {
        1: players[1] ? { ...players[1] } : { username: '黑手' },
        2: players[2] ? { ...players[2] } : { username: '白手' }
    };
    return {
        boardSize: BOARD_SIZE,
        board,
        currentPlayer: 1,
        moves: [],
        skillActive: { 1: null, 2: null },
        skillUsed: {
            1: createSkillUsage(),
            2: createSkillUsage()
        },
        blockedPositions: {},
        skipNextTurn: { 1: false, 2: false },
        coldPalacePositions: {},
        players: playerInfo,
        status: `${playerName({ players: playerInfo }, 1)}落子`,
        winner: null
    };
}

function createSkillUsage() {
    const usage = {};
    SKILLS.forEach(skill => usage[skill] = false);
    return usage;
}

function serializeState(state) {
    return {
        boardSize: state.boardSize,
        board: state.board.map(row => [...row]),
        currentPlayer: state.currentPlayer,
        skillActive: { ...state.skillActive },
        skillUsed: {
            1: { ...state.skillUsed[1] },
            2: { ...state.skillUsed[2] }
        },
        blockedPositions: { ...state.blockedPositions },
        skipNextTurn: { ...state.skipNextTurn },
        coldPalacePositions: { ...state.coldPalacePositions },
        players: {
            1: state.players[1] ? { ...state.players[1] } : null,
            2: state.players[2] ? { ...state.players[2] } : null
        },
        status: state.status,
        winner: state.winner
    };
}

function broadcastState(room) {
    const state = serializeState(room.state);
    [1, 2].forEach(player => {
        const client = room.clients[player];
        if (client && client.ws.readyState === WebSocket.OPEN) {
            send(client.ws, { type: 'state', state });
        }
    });
}

function checkWin(state, player, row, col) {
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of directions) {
        let count = 1;
        count += countDirection(state, player, row, col, dr, dc);
        count += countDirection(state, player, row, col, -dr, -dc);
        if (count >= 5) {
            return true;
        }
    }
    return false;
}

function countDirection(state, player, row, col, dr, dc) {
    let r = row + dr;
    let c = col + dc;
    let count = 0;
    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) {
        if (state.board[r][c] !== player) break;
        if (state.coldPalacePositions[`${r},${c}`]) break;
        count++;
        r += dr;
        c += dc;
    }
    return count;
}

function playerName(state, player) {
    const info = state.players && state.players[player];
    if (info && info.username) return info.username;
    return player === 1 ? '黑手' : '白手';
}

function opponentOf(player) {
    return player === 1 ? 2 : 1;
}

function removeMove(state, row, col) {
    const idx = state.moves.findIndex(move => move.row === row && move.col === col);
    if (idx >= 0) {
        state.moves.splice(idx, 1);
    }
}

function swapMoveOwner(state, row, col, player) {
    const move = state.moves.find(m => m.row === row && m.col === col);
    if (move) {
        move.player = player;
    }
}

function handleDisconnect(client) {
    cancelQueue(client);
    if (client.roomId) {
        const room = rooms.get(client.roomId);
        if (room) {
            const opponentNumber = client.playerNumber === 1 ? 2 : 1;
            const opponent = room.clients[opponentNumber];
            if (opponent && opponent.ws.readyState === opponent.ws.OPEN) {
                send(opponent.ws, { type: 'opponent_left' });
                opponent.roomId = null;
                opponent.playerNumber = null;
            }
            rooms.delete(client.roomId);
        }
    }
    client.roomId = null;
    client.playerNumber = null;
    client.queueing = false;
}

function send(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
        ws.send(JSON.stringify(payload));
    } catch (err) {
        console.error('Failed to send message', err);
    }
}

server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
