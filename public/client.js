const SKILLS = ['飞沙走石', '力拔山兮', '静如止水', '调呈离山', '时光倒流', '拾金不昧'];
const SKILL_DESCRIPTIONS = {
    '飞沙走石': '移除对手任意一枚棋子，并封锁该落点使其下一回合无法落子。',
    '力拔山兮': '掀翻棋盘，棋盘上当前的棋子随机掉落一半。',
    '静如止水': '冻结时间，使对手失去一回合落子机会。',
    '调呈离山': '强制将对手棋子移动到棋盘边缘的冷宫区，该棋子无法参与连珠。',
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

const sections = {
    login: document.getElementById('loginSection'),
    lobby: document.getElementById('lobbySection'),
    game: document.getElementById('gameSection')
};
const loginButton = document.getElementById('loginButton');
const usernameInput = document.getElementById('username');
const loginError = document.getElementById('loginError');
const matchButton = document.getElementById('matchButton');
const matchStatus = document.getElementById('matchStatus');
const currentUserEl = document.getElementById('currentUser');
const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const restartButton = document.getElementById('restart');
const playerCards = {
    1: document.getElementById('blackPlayer'),
    2: document.getElementById('whitePlayer')
};

const skillButtons = Array.from(document.querySelectorAll('[data-skill]'));

let socket;
let playerNumber = null;
let username = '';
let isQueueing = false;
let gameState = null;
let roomId = null;
let reconnectTimeout;

function showSection(name) {
    Object.values(sections).forEach(section => section.classList.remove('active'));
    sections[name].classList.add('active');
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

    socket.addEventListener('open', () => {
        loginButton.disabled = false;
        loginError.textContent = '';
    });

    socket.addEventListener('message', (event) => {
        let payload;
        try {
            payload = JSON.parse(event.data);
        } catch (err) {
            console.error('Invalid message', event.data);
            return;
        }
        handleMessage(payload);
    });

    socket.addEventListener('close', () => {
        loginButton.disabled = true;
        matchButton.disabled = true;
        statusEl.textContent = '与服务器连接已断开，尝试重新连接…';
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectWebSocket, 2000);
    });

    socket.addEventListener('error', () => {
        loginError.textContent = '连接服务器失败，请稍后重试。';
    });
}

function sendMessage(type, data = {}) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type, ...data }));
    }
}

function handleMessage(message) {
    switch (message.type) {
        case 'error':
            displayError(message.message || '发生未知错误');
            break;
        case 'login_success':
            username = message.username;
            showSection('lobby');
            currentUserEl.textContent = username;
            loginError.textContent = '';
            matchButton.disabled = false;
            break;
        case 'queue_update':
            handleQueueUpdate(message);
            break;
        case 'match_found':
            playerNumber = message.playerNumber;
            roomId = message.roomId;
            matchStatus.textContent = '';
            isQueueing = false;
            matchButton.textContent = '开始匹配';
            showSection('game');
            updatePlayers(message.players);
            updateState(message.state);
            break;
        case 'state':
            updateState(message.state);
            break;
        case 'opponent_left':
            statusEl.textContent = '对手已离开房间，返回大厅。';
            setTimeout(() => {
                resetGameSession();
                showSection('lobby');
            }, 1500);
            break;
        case 'info':
            statusEl.textContent = message.message || '';
            break;
        default:
            console.warn('Unknown message', message);
    }
}

function displayError(message) {
    if (sections.login.classList.contains('active')) {
        loginError.textContent = message;
    } else {
        statusEl.textContent = message;
    }
}

function handleQueueUpdate(message) {
    if (message.status === 'waiting') {
        matchStatus.textContent = '匹配中，请稍候…';
    } else if (message.status === 'queued') {
        matchStatus.textContent = '已加入匹配队列。';
    } else if (message.status === 'cancelled') {
        matchStatus.textContent = '匹配已取消。';
    }
}

function resetGameSession() {
    playerNumber = null;
    roomId = null;
    gameState = null;
    boardEl.innerHTML = '';
    statusEl.textContent = '';
    Object.values(playerCards).forEach(card => {
        card.classList.remove('current');
        card.querySelector('.name').textContent = '';
    });
    skillButtons.forEach(btn => {
        btn.disabled = true;
        btn.classList.remove('active', 'used');
    });
}

function updatePlayers(players) {
    if (!players) return;
    const blackName = players[1] ? players[1].username : '等待中';
    const whiteName = players[2] ? players[2].username : '等待中';
    playerCards[1].querySelector('.name').textContent = blackName;
    playerCards[2].querySelector('.name').textContent = whiteName;
}

function updateState(state) {
    if (!state) return;
    gameState = state;
    statusEl.textContent = state.status || '';
    updatePlayers(state.players);
    updateBoard(state);
    updateSkillButtons(state);
    updatePlayerHighlight(state);
}

function updatePlayerHighlight(state) {
    Object.keys(playerCards).forEach((key) => {
        playerCards[key].classList.toggle('current', Number(key) === state.currentPlayer && !state.winner);
    });
}

function updateBoard(state) {
    const size = state.boardSize;
    boardEl.style.gridTemplateColumns = `repeat(${size}, 32px)`;
    boardEl.innerHTML = '';
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            const cell = document.createElement('div');
            cell.className = 'cell';
            const key = `${r},${c}`;
            if (state.coldPalacePositions && state.coldPalacePositions[key]) {
                cell.classList.add('cold-palace');
            }
            const value = state.board[r][c];
            if (value === 1) {
                cell.textContent = '●';
            } else if (value === 2) {
                cell.textContent = '○';
            }
            if (!canInteractWithBoard(state)) {
                cell.classList.add('disabled');
            }
            cell.addEventListener('click', () => handleCellClick(r, c));
            boardEl.appendChild(cell);
        }
    }
}

function canInteractWithBoard(state) {
    if (!playerNumber) return false;
    if (state.winner) return false;
    if (state.currentPlayer !== playerNumber) return false;
    return true;
}

function handleCellClick(row, col) {
    if (!gameState) return;
    if (!canInteractWithBoard(gameState)) return;
    sendMessage('board_click', { roomId, row, col });
}

function updateSkillButtons(state) {
    skillButtons.forEach(btn => {
        const skill = btn.dataset.skill;
        const player = Number(btn.dataset.player);
        btn.classList.remove('active', 'used');
        if (!state.players[player]) {
            btn.disabled = true;
            return;
        }
        if (state.skillUsed && state.skillUsed[player] && state.skillUsed[player][skill]) {
            btn.classList.add('used');
        }
        if (state.skillActive && state.skillActive[player] === skill) {
            btn.classList.add('active');
        }
        const isCurrentPlayer = playerNumber === player && state.currentPlayer === player && !state.winner;
        const hasActiveSkill = state.skillActive && state.skillActive[player];
        const alreadyUsed = state.skillUsed && state.skillUsed[player] && state.skillUsed[player][skill];
        btn.disabled = !(isCurrentPlayer && !hasActiveSkill && !alreadyUsed);
    });
    if (playerNumber && state.skillActive[playerNumber]) {
        const skill = state.skillActive[playerNumber];
        statusEl.textContent = `${state.players[playerNumber].username} 选择了技能 ${skill}：${SKILL_DESCRIPTIONS[skill]} ${NEXT_STEP[skill]}`;
    }
}

loginButton.addEventListener('click', () => {
    const value = usernameInput.value.trim();
    if (!value) {
        loginError.textContent = '请输入昵称。';
        return;
    }
    if (value.length > 16) {
        loginError.textContent = '昵称长度不能超过 16 个字符。';
        return;
    }
    sendMessage('login', { username: value });
});

matchButton.addEventListener('click', () => {
    if (isQueueing) {
        isQueueing = false;
        matchButton.textContent = '开始匹配';
        sendMessage('cancel_queue');
    } else {
        isQueueing = true;
        matchButton.textContent = '取消匹配';
        matchStatus.textContent = '匹配中，请稍候…';
        sendMessage('find_match');
    }
});

skillButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const skill = btn.dataset.skill;
        const player = Number(btn.dataset.player);
        if (player !== playerNumber) return;
        sendMessage('activate_skill', { roomId, skill });
    });
});

restartButton.addEventListener('click', () => {
    sendMessage('restart', { roomId });
});

connectWebSocket();
