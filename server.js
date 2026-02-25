const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// ！！核心修复：开放跨域权限，确保 Railway 公网环境下握手成功！！
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// ==========================================
// V3.0 商业级大厅与游戏状态机
// ==========================================
let seats = [null, null, null, null]; // 4个固定物理座位
let spectators = []; // 观众席
let roomOwnerId = null; // 房主 ID

let matchConfig = { totalGames: 5, currentGame: 0, team1Wins: 0, team2Wins: 0 };
let teamOnStage = [0, 2]; 
let gameState = 'LOBBY'; // 初始状态为大厅: LOBBY, DRAWING, NEGOTIATING, BURYING, PLAYING
let deck = [], bottomCards = [], hands = [[], [], [], []];
let currentMainSuit = '?', isTrumpOverridden = false;
let currentTurnIndex = 0, drawCount = 0;
let currentTrick = [], offStageScore = 0, tricksPlayed = 0;
let wantStatus = { p1: null, p2: null }; 
let turnTimer = null;

// 随机昵称库
const nicknames = ["海淀赌神", "朝阳群众", "双扣狂魔", "摸鱼达人", "绝命毒师", "天选之子", "键盘刺客", "西二旗卷王"];

function emitSys(msg) { io.emit('systemMsg', msg); }
function startTimer(sec, cb) { 
    clearTimeout(turnTimer); io.emit('startTimer', sec);
    turnTimer = setTimeout(cb, sec * 1000);
}

// 广播大厅房间状态 (包括昵称、准备状态、座位)
function broadcastRoomState() {
    let roomData = seats.map(s => s ? { id: s.id, name: s.nickname, isReady: s.isReady, isOwner: s.isOwner } : null);
    io.emit('roomStateSync', { seats: roomData, spectatorsCount: spectators.length, state: gameState });
}

function broadcastGameState() {
    io.emit('gameStateSync', { match: matchConfig, onStage: teamOnStage, state: gameState, mainSuit: currentMainSuit, score: offStageScore });
}

// 核心比大小
function getW(card, leadSuit) {
    const s = (card.suit==='Joker'||['5','3','2'].includes(card.value)||card.suit===currentMainSuit)?'trump':card.suit;
    if (s !== leadSuit && s !== 'trump') return -1;
    const pt = {'4':4,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[card.value]||0;
    if (card.value === '5') return card.suit === currentMainSuit ? 100000 : 90000;
    if (card.value === '大王') return 80000; if (card.value === '小王') return 70000;
    if (card.value === '3') return card.suit === currentMainSuit ? 60000 : 50000;
    if (card.value === '2') return card.suit === currentMainSuit ? 40000 : 30000;
    return (s === 'trump' ? 20000 : 0) + pt;
}

// ==========================================
// 游戏引擎主循环 (保持 V2.0 逻辑)
// ==========================================
function startNewGame() {
    matchConfig.currentGame++; offStageScore = 0; tricksPlayed = 0; drawCount = 0;
    currentMainSuit = '?'; isTrumpOverridden = false; currentTrick = [];
    deck = [];
    const suits = ['♠', '♥', '♣', '♦'], values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    for (let i = 0; i < 2; i++) {
        suits.forEach(s => values.forEach(v => deck.push({ suit: s, value: v })));
        deck.push({ suit: 'Joker', value: '小王' }, { suit: 'Joker', value: '大王' });
    }
    deck.sort(() => Math.random() - 0.5);
    bottomCards = deck.splice(0, 8); hands = [[],[],[],[]];
    
    if (matchConfig.currentGame === 1) {
        let rev = deck.find(c => c.suit !== 'Joker'); currentMainSuit = rev.suit;
        let zhuang = -1;
        seats.forEach((p, i) => {
            if(!p) return;
            hands[i] = deck.splice(0, 25);
            if (hands[i].some(c => c.suit === rev.suit && c.value === rev.value)) zhuang = i;
            io.to(p.id).emit('initHand', hands[i]);
        });
        teamOnStage = [zhuang, (zhuang + 2) % 4]; currentTurnIndex = zhuang;
        gameState = 'BURYING'; broadcastGameState();
        emitSys(`第一局自动定主[${currentMainSuit}]，玩家[${seats[zhuang].nickname}]为庄。展示底牌...`);
        io.emit('showPub', bottomCards);
        setTimeout(() => { io.emit('clearPub'); io.emit('takeBottomSig', currentTurnIndex); }, 3000);
    } else {
        gameState = 'DRAWING'; currentTurnIndex = teamOnStage[Math.floor(Math.random()*2)];
        broadcastGameState(); triggerNextDraw();
    }
}

function triggerNextDraw() {
    if (drawCount >= 100) {
        gameState = 'POST_DRAW'; broadcastGameState();
        emitSys("摸牌结束。3秒后定主...");
        startTimer(3, () => {
            if (currentMainSuit === '?') {
                let maxV = -1, bestS = '♠';
                bottomCards.forEach(c => {
                    let v = {'4':4,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[c.value]||0;
                    if(c.suit!=='Joker' && v>maxV) { maxV=v; bestS=c.suit; }
                });
                currentMainSuit = bestS;
            }
            startNegotiation();
        });
        return;
    }
    io.emit('turnUpd', currentTurnIndex);
    startTimer(2, () => {
        let c = deck.shift(); hands[currentTurnIndex].push(c); drawCount++;
        io.to(seats[currentTurnIndex].id).emit('drawResp', c);
        currentTurnIndex = (currentTurnIndex + 1) % 4; triggerNextDraw();
    });
}

function startNegotiation() {
    gameState = 'NEGOTIATING'; broadcastGameState();
    io.emit('showPub', bottomCards); emitSys("请台上玩家在6秒内协商要牌...");
    startTimer(6, () => {
        let p1 = teamOnStage[0], p2 = teamOnStage[1];
        if (wantStatus.p1 && !wantStatus.p2) currentTurnIndex = p1;
        else if (!wantStatus.p1 && wantStatus.p2) currentTurnIndex = p2;
        else currentTurnIndex = teamOnStage[Math.floor(Math.random()*2)];
        io.emit('clearPub'); gameState = 'BURYING'; broadcastGameState();
        io.emit('takeBottomSig', currentTurnIndex);
    });
}

// ==========================================
// 核心：大厅 Socket 事件监听
// ==========================================
io.on('connection', (socket) => {
    socket.nickname = nicknames[Math.floor(Math.random() * nicknames.length)] + Math.floor(Math.random() * 100);
    socket.isReady = false;
    socket.isOwner = false;

    // 分配座位或观众席
    let emptyIdx = seats.findIndex(s => s === null);
    if (emptyIdx !== -1 && gameState === 'LOBBY') {
        socket.seatIndex = emptyIdx;
        seats[emptyIdx] = socket;
        if (!roomOwnerId) {
            roomOwnerId = socket.id;
            socket.isOwner = true;
        }
        io.to(socket.id).emit('seatAssigned', { seatIndex: emptyIdx, nickname: socket.nickname, isOwner: socket.isOwner });
    } else {
        socket.isSpectator = true;
        spectators.push(socket);
        io.to(socket.id).emit('spectatorMode', socket.nickname);
    }
    
    emitSys(`[${socket.nickname}] 进入了房间`);
    broadcastRoomState();

    socket.on('disconnect', () => {
        if (socket.isSpectator) {
            spectators = spectators.filter(s => s.id !== socket.id);
        } else {
            seats[socket.seatIndex] = null;
            emitSys(`[${socket.nickname}] 退出了房间`);
            // 如果房主退了，顺延给下一个有座位的玩家
            if (socket.isOwner) {
                let nextPlayer = seats.find(s => s !== null);
                if (nextPlayer) {
                    nextPlayer.isOwner = true; roomOwnerId = nextPlayer.id;
                    emitSys(`[${nextPlayer.nickname}] 自动成为新房主`);
                } else {
                    roomOwnerId = null;
                }
            }
            // 如果游戏正在进行且有人掉线，强制退回大厅
            if (gameState !== 'LOBBY') {
                gameState = 'LOBBY'; clearTimeout(turnTimer);
                emitSys("⚠️ 玩家掉线，对局强行中止，返回大厅。");
                seats.forEach(s => { if(s) s.isReady = false; });
            }
        }
        broadcastRoomState();
    });

    // 大厅准备机制
    socket.on('toggleReady', () => {
        if (!socket.isOwner && !socket.isSpectator && gameState === 'LOBBY') {
            socket.isReady = !socket.isReady;
            broadcastRoomState();
        }
    });

    // 房主开始游戏
    socket.on('startGame', (len) => {
        if (socket.isOwner && gameState === 'LOBBY') {
            // 校验是否坐满4人且除了房主外其余3人都已准备
            let seatedCount = seats.filter(s => s !== null).length;
            let readyCount = seats.filter(s => s !== null && (s.isReady || s.isOwner)).length;
            
            if (seatedCount === 4 && readyCount === 4) {
                matchConfig.totalGames = parseInt(len);
                startNewGame();
            }
        }
    });

    // 游戏交互信号
    socket.on('callTrump', (s) => { if(currentMainSuit==='?'){ currentMainSuit=s; broadcastGameState(); emitSys(`[${socket.nickname}]亮3定主[${s}]`); }});
    socket.on('overrideTrump', (s) => { if(!isTrumpOverridden){ currentMainSuit=s; isTrumpOverridden=true; broadcastGameState(); emitSys(`🔥 [${socket.nickname}]双3反主[${s}]！`); }});
    socket.on('toggleWant', (w) => { if(socket.seatIndex===teamOnStage[0]) wantStatus.p1=w; if(socket.seatIndex===teamOnStage[1]) wantStatus.p2=w; });
    socket.on('takeBottomAck', () => { io.to(socket.id).emit('recvBottom', bottomCards); emitSys("庄家正在扣底..."); startTimer(45, ()=>{}); });
    
    socket.on('buryCards', (cards) => {
        clearTimeout(turnTimer); bottomCards = cards;
        io.emit('showPub', bottomCards); emitSys("展示扣底牌3秒...");
        setTimeout(() => {
            io.emit('clearPub'); gameState = 'PLAYING'; broadcastGameState();
            io.emit('turnUpd', currentTurnIndex); startTimer(15, ()=>{});
        }, 3000);
    });

    socket.on('playCards', (cards) => {
        clearTimeout(turnTimer); currentTrick.push({ idx: socket.seatIndex, cards });
        io.emit('playerPlayed', { idx: socket.seatIndex, cards });
        if (currentTrick.length === 4) {
            tricksPlayed++;
            let leadSuit = (currentTrick[0].cards[0].suit==='Joker'||['5','3','2'].includes(currentTrick[0].cards[0].value)||currentTrick[0].cards[0].suit===currentMainSuit)?'trump':currentTrick[0].cards[0].suit;
            let hiW = -1, winIdx = -1, pts = 0;
            currentTrick.forEach(p => {
                pts += p.cards.reduce((sum, c) => sum + (c.value === '5' ? 5 : (['10','K'].includes(c.value) ? 10 : 0)), 0);
                let w = getW(p.cards[0], leadSuit);
                if (w > hiW) { hiW = w; winIdx = p.idx; }
            });
            if (!teamOnStage.includes(winIdx)) { offStageScore += pts; broadcastGameState(); }
            
            if (tricksPlayed === 25) {
                if (!teamOnStage.includes(winIdx)) offStageScore += bottomCards.reduce((sum, c) => sum + (c.value === '5' ? 5 : (['10','K'].includes(c.value) ? 10 : 0)), 0);
                broadcastGameState();
                let winTeam1 = (offStageScore < 80);
                if (teamOnStage.includes(0)) { if(winTeam1) matchConfig.team1Wins++; else { matchConfig.team2Wins++; teamOnStage=[1,3]; } }
                else { if(!winTeam1) matchConfig.team2Wins++; else { matchConfig.team1Wins++; teamOnStage=[0,2]; } }
                emitSys(`局终！台下拿了${offStageScore}分。`);
                
                setTimeout(startNewGame, 8000);
                return;
            }
            setTimeout(() => { currentTrick = []; currentTurnIndex = winIdx; io.emit('clearTable'); io.emit('turnUpd', winIdx); startTimer(15, ()=>{}); }, 2000);
        } else {
            currentTurnIndex = (currentTurnIndex + 1) % 4; io.emit('turnUpd', currentTurnIndex); startTimer(15, ()=>{});
        }
    });
});

// ！！核心修复：监听 0.0.0.0 泛地址！！
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
    console.log(`V3.0 房间大厅已在端口 ${PORT} 启动`);
});
