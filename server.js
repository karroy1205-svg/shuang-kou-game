const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// 开放全域跨域，保证云端长连接不被阻断
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// ==========================================
// 全局大厅与游戏状态机
// ==========================================
let seats = [null, null, null, null]; 
let spectators = []; 
let roomOwnerId = null; 

let matchConfig = { totalGames: 5, currentGame: 0, team1Wins: 0, team2Wins: 0 };
let teamOnStage = []; // 台上阵营
let gameState = 'LOBBY'; 
let deck = [], bottomCards = [], hands = [[], [], [], []];
let currentMainSuit = '?', isTrumpOverridden = false;
let currentTurnIndex = 0, drawCount = 0;
let currentTrick = [], offStageScore = 0, tricksPlayed = 0;
let wantStatus = { p1: null, p2: null }; 
let turnTimer = null;
let targetCard = null; // 第一局的“天命定庄牌”

const nicknames = ["海淀赌神", "朝阳群众", "双扣狂魔", "摸鱼达人", "绝命毒师", "天选之子", "键盘刺客", "西二旗卷王"];

function emitSys(msg) { io.emit('systemMsg', msg); }
function startTimer(sec, cb) { 
    clearTimeout(turnTimer); io.emit('startTimer', sec);
    turnTimer = setTimeout(cb, sec * 1000);
}

function broadcastRoomState() {
    let roomData = seats.map(s => s ? { id: s.id, name: s.nickname, isReady: s.isReady, isOwner: s.isOwner } : null);
    io.emit('roomStateSync', { seats: roomData, spectatorsCount: spectators.length, state: gameState });
}

function broadcastGameState() {
    io.emit('gameStateSync', { match: matchConfig, onStage: teamOnStage, state: gameState, mainSuit: currentMainSuit, score: offStageScore, isFirstGame: matchConfig.currentGame === 1 });
}

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
// 108张线下摸牌引擎
// ==========================================
function startNewGame() {
    matchConfig.currentGame++; offStageScore = 0; tricksPlayed = 0; drawCount = 0;
    currentMainSuit = '?'; isTrumpOverridden = false; currentTrick = []; targetCard = null;
    wantStatus = { p1: null, p2: null }; hands = [[],[],[],[]];
    
    // 生成108张并洗牌
    deck = [];
    const suits = ['♠', '♥', '♣', '♦'], values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    for (let i = 0; i < 2; i++) {
        suits.forEach(s => values.forEach(v => deck.push({ suit: s, value: v })));
        deck.push({ suit: 'Joker', value: '小王' }, { suit: 'Joker', value: '大王' });
    }
    deck.sort(() => Math.random() - 0.5);

    // 第一局独有逻辑：抽出一张牌翻开
    if (matchConfig.currentGame === 1) {
        teamOnStage = []; // 身份迷雾
        let revIdx = deck.findIndex(c => c.suit !== 'Joker');
        targetCard = deck.splice(revIdx, 1)[0];
        currentMainSuit = targetCard.suit;
        // 把这张牌随机插回牌堆中段 (第20到80张之间)
        let insertPos = Math.floor(Math.random() * 60) + 20;
        deck.splice(insertPos, 0, targetCard);
        
        currentTurnIndex = Math.floor(Math.random() * 4); // 第一局随机首抓
        emitSys(`第一局开始！牌堆已翻开 [${currentMainSuit}${targetCard.value}]，抓到者即为庄家！`);
    } else {
        // 第二局起，由台上玩家开始摸牌
        currentTurnIndex = teamOnStage.length > 0 ? teamOnStage[Math.floor(Math.random()*2)] : Math.floor(Math.random() * 4);
        emitSys(`第 ${matchConfig.currentGame} 局开始，请摸牌！`);
    }
    
    gameState = 'DRAWING';
    
    // ！！核心修复：强制向所有客户端发送隐藏大厅信号！！
    io.emit('hideLobby'); 
    broadcastGameState();
    triggerNextDraw();
}

function triggerNextDraw() {
    // 广播牌堆剩余数量
    io.emit('deckSync', { remain: 108 - drawCount, target: matchConfig.currentGame === 1 ? targetCard : null });

    if (drawCount >= 100) {
        // 剩下的8张作为底牌
        bottomCards = deck.splice(0, 8);
        io.emit('deckSync', { remain: 0, target: null });

        if (matchConfig.currentGame === 1) {
            // 首局：底牌自动给庄家
            gameState = 'BURYING';
            currentTurnIndex = teamOnStage[0]; // 庄家
            broadcastGameState();
            io.emit('showPub', bottomCards);
            emitSys(`摸牌结束！底牌自动归属庄家。展示3秒...`);
            setTimeout(() => {
                io.emit('clearPub'); io.emit('takeBottomSig', currentTurnIndex);
            }, 3000);
        } else {
            // 后续局：双3反主结算期
            gameState = 'POST_DRAW'; broadcastGameState();
            emitSys("摸牌结束。3秒最后亮主机会...");
            startTimer(3, () => {
                if (currentMainSuit === '?') {
                    let maxV = -1, bestS = '♠';
                    bottomCards.forEach(c => {
                        let v = {'4':4,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[c.value]||0;
                        if(c.suit!=='Joker' && v>maxV) { maxV=v; bestS=c.suit; }
                    });
                    currentMainSuit = bestS;
                    emitSys(`无人亮牌，底牌强制定主为[${currentMainSuit}]`);
                }
                startNegotiation();
            });
        }
        return;
    }
    
    io.emit('turnUpd', currentTurnIndex);
    // 玩家不点，1.5秒自动代摸
    startTimer(1.5, () => { executeDraw(currentTurnIndex); });
}

function executeDraw(pIndex) {
    if (gameState !== 'DRAWING') return;
    clearTimeout(turnTimer);
    
    let card = deck.shift();
    hands[pIndex].push(card);
    drawCount++;
    io.to(seats[pIndex].id).emit('drawResp', card);
    
    // 第一局身份判定机制
    if (matchConfig.currentGame === 1 && targetCard && card.suit === targetCard.suit && card.value === targetCard.value) {
        if (teamOnStage.length === 0) { // 防止同牌面的另一张被抓到引发重复
            teamOnStage = [pIndex, (pIndex + 2) % 4];
            targetCard = null; // 目标达成，天命牌消失
            emitSys(`🎉 玩家[${seats[pIndex].nickname}] 抓到了天命牌！身份揭晓，正式成为庄家！`);
            broadcastGameState();
        }
    }
    
    currentTurnIndex = (currentTurnIndex + 1) % 4;
    triggerNextDraw();
}

function startNegotiation() {
    gameState = 'NEGOTIATING'; broadcastGameState();
    io.emit('showPub', bottomCards); emitSys("请台上玩家在6秒内协商要底牌...");
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
// Socket 通信
// ==========================================
io.on('connection', (socket) => {
    socket.nickname = nicknames[Math.floor(Math.random() * nicknames.length)] + Math.floor(Math.random() * 100);
    socket.isReady = false; socket.isOwner = false;

    let emptyIdx = seats.findIndex(s => s === null);
    if (emptyIdx !== -1 && gameState === 'LOBBY') {
        socket.seatIndex = emptyIdx; seats[emptyIdx] = socket;
        if (!roomOwnerId) { roomOwnerId = socket.id; socket.isOwner = true; }
        io.to(socket.id).emit('seatAssigned', { seatIndex: emptyIdx, nickname: socket.nickname, isOwner: socket.isOwner });
    } else {
        socket.isSpectator = true; spectators.push(socket);
        io.to(socket.id).emit('spectatorMode', socket.nickname);
    }
    
    emitSys(`[${socket.nickname}] 进入了房间`);
    broadcastRoomState();

    socket.on('disconnect', () => {
        if (socket.isSpectator) spectators = spectators.filter(s => s.id !== socket.id);
        else {
            seats[socket.seatIndex] = null;
            emitSys(`[${socket.nickname}] 退出`);
            if (socket.isOwner) {
                let nextPlayer = seats.find(s => s !== null);
                if (nextPlayer) { nextPlayer.isOwner = true; roomOwnerId = nextPlayer.id; }
                else roomOwnerId = null;
            }
            if (gameState !== 'LOBBY') {
                gameState = 'LOBBY'; clearTimeout(turnTimer);
                emitSys("⚠️ 对局被强行中止，返回大厅。");
                seats.forEach(s => { if(s) s.isReady = false; });
                io.emit('showLobbyFallback'); // 强制恢复大厅
            }
        }
        broadcastRoomState();
    });

    socket.on('toggleReady', () => {
        if (!socket.isOwner && !socket.isSpectator && gameState === 'LOBBY') {
            socket.isReady = !socket.isReady; broadcastRoomState();
        }
    });

    socket.on('startGame', (len) => {
        if (socket.isOwner && gameState === 'LOBBY') {
            let readyCount = seats.filter(s => s !== null && (s.isReady || s.isOwner)).length;
            if (seats.filter(s => s !== null).length === 4 && readyCount === 4) {
                matchConfig.totalGames = parseInt(len);
                startNewGame();
            } else {
                socket.emit('systemMsg', "请等待全员准备！");
            }
        }
    });

    socket.on('reqDraw', () => { if (socket.seatIndex === currentTurnIndex) executeDraw(socket.seatIndex); });
    socket.on('callTrump', (s) => { if(currentMainSuit==='?' && matchConfig.currentGame > 1){ currentMainSuit=s; broadcastGameState(); emitSys(`[${socket.nickname}]亮3定主[${s}]`); }});
    socket.on('overrideTrump', (s) => { if(!isTrumpOverridden && matchConfig.currentGame > 1){ currentMainSuit=s; isTrumpOverridden=true; broadcastGameState(); emitSys(`🔥 [${socket.nickname}]双3反主[${s}]！`); }});
    socket.on('toggleWant', (w) => { if(socket.seatIndex===teamOnStage[0]) wantStatus.p1=w; if(socket.seatIndex===teamOnStage[1]) wantStatus.p2=w; });
    socket.on('takeBottomAck', () => { io.to(socket.id).emit('recvBottom', bottomCards); emitSys("庄家正在扣底..."); startTimer(45, ()=>{}); });
    
    socket.on('buryCards', (cards) => {
        clearTimeout(turnTimer); bottomCards = cards;
        io.emit('showPub', bottomCards); emitSys("扣底完成，展示3秒...");
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
                emitSys(`局终！台下拿了${offStageScore}分。8秒后下一局...`);
                setTimeout(startNewGame, 8000);
                return;
            }
            setTimeout(() => { currentTrick = []; currentTurnIndex = winIdx; io.emit('clearTable'); io.emit('turnUpd', winIdx); startTimer(15, ()=>{}); }, 2000);
        } else {
            currentTurnIndex = (currentTurnIndex + 1) % 4; io.emit('turnUpd', currentTurnIndex); startTimer(15, ()=>{});
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => { console.log(`云端服务器已启动`); });
