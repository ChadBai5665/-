const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 11;
const SKILL_NAMES = ['飞沙走石', '力拔山兮', '静如止水', '调呈离山', '时光倒流', '拾金不昧'];

const users = new Map(); // username -> { password }
const activeUsers = new Map(); // username -> socketId
const waitingQueue = [];
const games = new Map(); // gameId -> gameState
const socketToGame = new Map(); // socketId -> { gameId, seat }
let gameCounter = 1;

app.use(express.static(path.join(__dirname)));

server.listen(PORT, () => {
  console.log(`技能五子棋服务器已启动，端口: ${PORT}`);
});

io.on('connection', (socket) => {
  socket.on('login', (payload) => handleLogin(socket, payload));
  socket.on('activateSkill', (skill) => handleSkillActivation(socket, skill));
  socket.on('makeMove', (payload) => handleMove(socket, payload));
  socket.on('requestRestart', () => handleRestartRequest(socket));
  socket.on('disconnect', () => handleDisconnect(socket));
});

function handleLogin(socket, payload) {
  const { username, password } = payload || {};
  if (!username || !password) {
    socket.emit('errorMessage', '用户名和密码均不能为空。');
    return;
  }

  const sanitizedName = String(username).trim();
  if (sanitizedName.length < 2 || sanitizedName.length > 20) {
    socket.emit('errorMessage', '用户名长度需在 2 到 20 个字符之间。');
    return;
  }

  const account = users.get(sanitizedName);
  if (account) {
    if (account.password !== password) {
      socket.emit('errorMessage', '密码不正确，请重试。');
      return;
    }
    const existingSocket = activeUsers.get(sanitizedName);
    if (existingSocket && existingSocket !== socket.id) {
      socket.emit('errorMessage', '该账号已在其他位置登录。');
      return;
    }
  } else {
    users.set(sanitizedName, { password });
  }

  activeUsers.set(sanitizedName, socket.id);
  socket.data.username = sanitizedName;

  socket.emit('loginSuccess', {
    username: sanitizedName,
    message: account ? '登录成功。' : '首次登录已为您创建新账号。',
  });

  queuePlayer(socket);
}

function queuePlayer(socket) {
  const username = socket.data.username;
  if (!username) return;

  // 如果玩家已经在队列或对局中，避免重复排队
  if (waitingQueue.find((item) => item.id === socket.id)) {
    return;
  }
  if (socketToGame.has(socket.id)) {
    return;
  }

  if (waitingQueue.length === 0) {
    waitingQueue.push(socket);
    socket.emit('queueStatus', { message: '匹配中，请等待其他玩家加入……' });
    return;
  }

  const opponent = waitingQueue.shift();
  if (!opponent.connected) {
    queuePlayer(socket);
    return;
  }

  startGame(opponent, socket);
}

function startGame(socketA, socketB) {
  const gameId = `game-${gameCounter++}`;
  const player1 = { socketId: socketA.id, username: socketA.data.username };
  const player2 = { socketId: socketB.id, username: socketB.data.username };

  const gameState = {
    id: gameId,
    board: createBoard(BOARD_SIZE),
    moves: [],
    skillActive: { 1: null, 2: null },
    skillUsed: {
      1: createSkillUsageMap(),
      2: createSkillUsageMap(),
    },
    blockedPositions: {},
    skipNextTurn: { 1: false, 2: false },
    coldPalacePositions: {},
    currentPlayer: 1,
    winner: null,
    status: `${player1.username}落子`,
    players: { 1: player1, 2: player2 },
    restartVotes: new Set(),
  };

  games.set(gameId, gameState);
  socketToGame.set(player1.socketId, { gameId, seat: 1 });
  socketToGame.set(player2.socketId, { gameId, seat: 2 });

  const initialState = exportState(gameState);
  io.to(player1.socketId).emit('matchFound', { seat: 1, state: initialState });
  io.to(player2.socketId).emit('matchFound', { seat: 2, state: initialState });
}

function createBoard(size) {
  return Array.from({ length: size }, () => Array(size).fill(0));
}

function createSkillUsageMap() {
  const map = {};
  for (const skill of SKILL_NAMES) {
    map[skill] = false;
  }
  return map;
}

function exportState(game) {
  return {
    board: game.board,
    boardSize: BOARD_SIZE,
    currentPlayer: game.currentPlayer,
    skillActive: { ...game.skillActive },
    skillUsed: {
      1: { ...game.skillUsed[1] },
      2: { ...game.skillUsed[2] },
    },
    blockedPositions: { ...game.blockedPositions },
    skipNextTurn: { ...game.skipNextTurn },
    coldPalacePositions: Object.keys(game.coldPalacePositions),
    status: game.status,
    winner: game.winner,
    players: {
      1: { username: game.players[1].username },
      2: { username: game.players[2].username },
    },
    restartVotes: Array.from(game.restartVotes),
  };
}

function handleSkillActivation(socket, skill) {
  const entry = socketToGame.get(socket.id);
  if (!entry) {
    socket.emit('errorMessage', '当前未在对局中，无法发动技能。');
    return;
  }
  const { gameId, seat } = entry;
  const game = games.get(gameId);
  if (!game || game.winner) {
    socket.emit('errorMessage', '对局已结束。');
    return;
  }
  if (!SKILL_NAMES.includes(skill)) {
    socket.emit('errorMessage', '未知技能。');
    return;
  }
  if (game.currentPlayer !== seat) {
    socket.emit('errorMessage', '未到您的回合。');
    return;
  }
  if (game.skillActive[seat]) {
    socket.emit('errorMessage', '您已选择技能，请先完成当前技能操作。');
    return;
  }
  if (game.skillUsed[seat][skill]) {
    socket.emit('errorMessage', '该技能已使用过。');
    return;
  }

  game.skillActive[seat] = skill;
  game.status = `${game.players[seat].username}选择了技能 ${skill}。`;
  broadcastState(game);
}

function handleMove(socket, payload) {
  const { row, col } = payload || {};
  const entry = socketToGame.get(socket.id);
  if (!entry) {
    socket.emit('errorMessage', '当前未在对局中。');
    return;
  }
  const { gameId, seat } = entry;
  const game = games.get(gameId);
  if (!game) return;

  if (game.winner) {
    socket.emit('errorMessage', '对局已结束。');
    return;
  }
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= BOARD_SIZE || col >= BOARD_SIZE) {
    socket.emit('errorMessage', '落子坐标非法。');
    return;
  }
  if (game.currentPlayer !== seat) {
    socket.emit('errorMessage', '未到您的回合。');
    return;
  }

  const activeSkill = game.skillActive[seat];
  let actionHandled = false;

  if (activeSkill) {
    actionHandled = applySkill(game, seat, row, col);
    if (!actionHandled) {
      broadcastState(game);
      return;
    }
  } else {
    const key = `${row},${col}`;
    if (game.board[row][col] !== 0) {
      socket.emit('errorMessage', '该位置已存在棋子。');
      return;
    }
    if (game.blockedPositions[key] === seat) {
      socket.emit('errorMessage', '该位置已被飞沙走石封锁，本回合无法落子。');
      return;
    }

    game.board[row][col] = seat;
    game.moves.push({ row, col, player: seat });
    delete game.coldPalacePositions[key];
    game.restartVotes.clear();

    if (checkWin(game, seat, row, col)) {
      game.winner = seat;
      game.status = `${game.players[seat].username}胜利！`;
      clearBlockedForPlayer(game, seat);
    } else {
      finishTurn(game, seat, `${game.players[seat].username}在 (${row + 1}, ${col + 1}) 落子。`);
    }

    actionHandled = true;
  }

  if (actionHandled) {
    broadcastState(game);
  }
}

function handleRestartRequest(socket) {
  const entry = socketToGame.get(socket.id);
  if (!entry) {
    socket.emit('errorMessage', '当前未在对局中。');
    return;
  }
  const { gameId, seat } = entry;
  const game = games.get(gameId);
  if (!game) return;

  if (!game.restartVotes) {
    game.restartVotes = new Set();
  }
  game.restartVotes.add(seat);

  const opponentSeat = otherPlayer(seat);
  const opponentSocketId = game.players[opponentSeat]?.socketId;
  const message = `${game.players[seat].username}请求重开一局。`;
  io.to(socket.id).emit('infoMessage', '已提交重开请求，等待对手确认。');
  if (opponentSocketId) {
    io.to(opponentSocketId).emit('infoMessage', message);
  }

  if (game.restartVotes.size >= 2) {
    resetGame(game);
    broadcastState(game);
  }
}

function resetGame(game) {
  game.board = createBoard(BOARD_SIZE);
  game.moves = [];
  game.skillActive = { 1: null, 2: null };
  game.skillUsed = {
    1: createSkillUsageMap(),
    2: createSkillUsageMap(),
  };
  game.blockedPositions = {};
  game.skipNextTurn = { 1: false, 2: false };
  game.coldPalacePositions = {};
  game.currentPlayer = 1;
  game.winner = null;
  game.restartVotes = new Set();
  game.status = `${game.players[1].username}落子`;
}

function handleDisconnect(socket) {
  const username = socket.data.username;
  if (username) {
    activeUsers.delete(username);
  }

  const queueIndex = waitingQueue.findIndex((item) => item.id === socket.id);
  if (queueIndex !== -1) {
    waitingQueue.splice(queueIndex, 1);
  }

  const entry = socketToGame.get(socket.id);
  if (!entry) {
    return;
  }

  const { gameId, seat } = entry;
  const game = games.get(gameId);
  socketToGame.delete(socket.id);

  if (!game) {
    return;
  }

  const opponentSeat = otherPlayer(seat);
  const opponentInfo = game.players[opponentSeat];
  if (opponentInfo) {
    const opponentSocket = io.sockets.sockets.get(opponentInfo.socketId);
    if (opponentSocket) {
      socketToGame.delete(opponentInfo.socketId);
      opponentSocket.emit('opponentLeft', {
        message: `${username || '对手'}已离线，系统将为您重新匹配新的对手。`,
      });
      games.delete(gameId);
      queuePlayer(opponentSocket);
      return;
    }
  }

  games.delete(gameId);
}

function applySkill(game, player, row, col) {
  const skill = game.skillActive[player];
  if (!skill) return false;

  const opponent = otherPlayer(player);
  const playerName = game.players[player].username;
  const opponentName = game.players[opponent].username;
  const key = `${row},${col}`;

  switch (skill) {
    case '飞沙走石': {
      let message = `${playerName}发动飞沙走石，但未命中对手棋子。`;
      if (game.board[row][col] === opponent) {
        game.board[row][col] = 0;
        delete game.coldPalacePositions[key];
        game.blockedPositions[key] = opponent;
        message = `${playerName}发动飞沙走石，移除了${opponentName}的一枚棋子。`;
      }
      game.skillActive[player] = null;
      game.skillUsed[player][skill] = true;
      game.restartVotes.clear();
      finishTurn(game, player, message);
      return true;
    }
    case '力拔山兮': {
      const removedMovesKeys = [];
      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          if (game.board[r][c] !== 0 && Math.random() < 0.5) {
            game.board[r][c] = 0;
            delete game.coldPalacePositions[`${r},${c}`];
            removedMovesKeys.push(`${r},${c}`);
          }
        }
      }
      cleanupMovesAfterBoardChange(game, removedMovesKeys);
      game.skillActive[player] = null;
      game.skillUsed[player][skill] = true;
      game.restartVotes.clear();
      finishTurn(game, player, `${playerName}发动力拔山兮，棋盘剧烈震荡！`);
      return true;
    }
    case '静如止水': {
      game.skipNextTurn[opponent] = true;
      game.skillActive[player] = null;
      game.skillUsed[player][skill] = true;
      game.restartVotes.clear();
      finishTurn(game, player, `${playerName}发动静如止水，${opponentName}将失去一个回合。`);
      return true;
    }
    case '调呈离山': {
      if (game.board[row][col] === opponent) {
        const edges = [];
        for (let r = 0; r < BOARD_SIZE; r++) {
          for (let c = 0; c < BOARD_SIZE; c++) {
            if (r === 0 || c === 0 || r === BOARD_SIZE - 1 || c === BOARD_SIZE - 1) {
              if (game.board[r][c] === 0) {
                edges.push({ r, c });
              }
            }
          }
        }
        if (edges.length > 0) {
          const idx = Math.floor(Math.random() * edges.length);
          const target = edges[idx];
          game.board[row][col] = 0;
          delete game.coldPalacePositions[key];
          game.board[target.r][target.c] = opponent;
          game.coldPalacePositions[`${target.r},${target.c}`] = true;
        }
      }
      game.skillActive[player] = null;
      game.skillUsed[player][skill] = true;
      game.restartVotes.clear();
      finishTurn(game, player, `${playerName}施展调呈离山。`);
      return true;
    }
    case '时光倒流': {
      let removed = 0;
      const removedKeys = new Set();
      while (game.moves.length > 0 && removed < 3) {
        const lastMove = game.moves.pop();
        const moveKey = `${lastMove.row},${lastMove.col}`;
        game.board[lastMove.row][lastMove.col] = 0;
        delete game.coldPalacePositions[moveKey];
        removedKeys.add(moveKey);
        removed += 1;
      }

      for (const keyToRemove of removedKeys) {
        if (game.blockedPositions[keyToRemove]) {
          delete game.blockedPositions[keyToRemove];
        }
      }

      clearBlockedForPlayer(game, player);
      game.skillActive[player] = null;
      game.skillUsed[player][skill] = true;
      game.restartVotes.clear();
      game.winner = null;

      if (game.moves.length === 0) {
        game.currentPlayer = 1;
      } else {
        const lastMove = game.moves[game.moves.length - 1];
        game.currentPlayer = otherPlayer(lastMove.player);
      }

      const baseMessage = `${playerName}发动时光倒流，将棋局回退${removed}步。`;
      const skipInfo = applySkip(game);
      if (skipInfo.message) {
        game.status = `${baseMessage} ${skipInfo.message}`;
      } else {
        const nextName = game.players[game.currentPlayer].username;
        game.status = `${baseMessage} 轮到${nextName}落子。`;
      }
      return true;
    }
    case '拾金不昧': {
      const currentPieces = [];
      const opponentPieces = [];
      for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
          if (game.board[r][c] === player) {
            currentPieces.push({ r, c });
          } else if (game.board[r][c] === opponent) {
            opponentPieces.push({ r, c });
          }
        }
      }

      if (currentPieces.length > 0 && opponentPieces.length > 0) {
        const cp = currentPieces[Math.floor(Math.random() * currentPieces.length)];
        const op = opponentPieces[Math.floor(Math.random() * opponentPieces.length)];
        const cpKey = `${cp.r},${cp.c}`;
        const opKey = `${op.r},${op.c}`;
        const cpCold = Boolean(game.coldPalacePositions[cpKey]);
        const opCold = Boolean(game.coldPalacePositions[opKey]);

        game.board[cp.r][cp.c] = opponent;
        game.board[op.r][op.c] = player;

        delete game.coldPalacePositions[cpKey];
        delete game.coldPalacePositions[opKey];
        if (cpCold) {
          game.coldPalacePositions[opKey] = true;
        }
        if (opCold) {
          game.coldPalacePositions[cpKey] = true;
        }
      }

      game.skillActive[player] = null;
      game.skillUsed[player][skill] = true;
      game.restartVotes.clear();
      finishTurn(game, player, `${playerName}发动拾金不昧，棋子位置发生了变化。`);
      return true;
    }
    default:
      return false;
  }
}

function cleanupMovesAfterBoardChange(game, removedKeys) {
  if (!removedKeys || removedKeys.length === 0) {
    return;
  }
  const removedSet = new Set(removedKeys);
  game.moves = game.moves.filter((move) => !removedSet.has(`${move.row},${move.col}`));
}

function finishTurn(game, player, actionMessage) {
  clearBlockedForPlayer(game, player);
  if (game.winner) {
    game.status = `${game.players[player].username}胜利！`;
    return;
  }

  game.currentPlayer = otherPlayer(player);
  const skipInfo = applySkip(game);

  if (skipInfo.message) {
    if (actionMessage) {
      game.status = `${actionMessage} ${skipInfo.message}`;
    } else {
      game.status = skipInfo.message;
    }
  } else {
    const nextName = game.players[game.currentPlayer].username;
    if (actionMessage) {
      game.status = `${actionMessage} 轮到${nextName}落子。`;
    } else {
      game.status = `${nextName}落子`;
    }
  }
}

function applySkip(game) {
  let message = null;
  let processed = false;
  while (game.skipNextTurn[game.currentPlayer]) {
    const skippedPlayer = game.currentPlayer;
    game.skipNextTurn[skippedPlayer] = false;
    clearBlockedForPlayer(game, skippedPlayer);
    const nextPlayer = otherPlayer(skippedPlayer);
    message = `${game.players[skippedPlayer].username}失去了一个回合，轮到${game.players[nextPlayer].username}落子。`;
    game.currentPlayer = nextPlayer;
    processed = true;
  }
  return { message, processed };
}

function clearBlockedForPlayer(game, player) {
  for (const key of Object.keys(game.blockedPositions)) {
    if (game.blockedPositions[key] === player) {
      delete game.blockedPositions[key];
    }
  }
}

function checkWin(game, player, row, col) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  for (const [dr, dc] of directions) {
    let total = 1;
    total += countStones(game, player, row, col, dr, dc);
    total += countStones(game, player, row, col, -dr, -dc);
    if (total >= 5) {
      return true;
    }
  }
  return false;
}

function countStones(game, player, row, col, dr, dc) {
  let count = 0;
  let r = row + dr;
  let c = col + dc;
  while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) {
    if (game.board[r][c] === player && !game.coldPalacePositions[`${r},${c}`]) {
      count += 1;
      r += dr;
      c += dc;
    } else {
      break;
    }
  }
  return count;
}

function otherPlayer(player) {
  return player === 1 ? 2 : 1;
}

function broadcastState(game) {
  const state = exportState(game);
  for (const seat of [1, 2]) {
    const socketId = game.players[seat]?.socketId;
    if (socketId) {
      io.to(socketId).emit('stateUpdate', state);
    }
  }
}
module.exports = server;
