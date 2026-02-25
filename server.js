const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

let seats = [null, null, null, null]; 
let spectators = []; 
let roomOwnerId = null; 

let matchConfig = { totalGames: 5, currentGame: 0, team1Wins: 0, team2Wins: 0 };
let teamOnStage = []; 
let gameState = 'LOBBY'; 
let deck = [], bottomCards = [], hands = [[], [], [], []];
let currentMainSuit = '?', isTrumpOverridden = false;
let currentTurnIndex = 0, drawCount = 0;
let currentTrick = [], offStageScore = 0, tricksPlayed = 0;
let wantStatus = { p1: null, p2: null }; 
let turnTimer = null;
let targetCard = null; 

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

function getEffectiveSuit(card) {
    if (card.suit === 'Joker' || ['5','3','2'].includes(card.value) || card.suit === currentMainSuit) return 'trump';
    return card.suit;
}

// 用于出牌比大小的权重
function getW(card, leadSuit) {
    const s = getEffectiveSuit(card);
    if (s !== leadSuit && s !== 'trump') return -1;
    const pt = {'4':4,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[card.value]||0;
    if (card.value === '5') return card.suit === currentMainSuit ? 100000 : 90000;
    if (card.value === '大王') return 80000; if (card.value === '小王') return 70000;
    if (card.value === '3') return card.suit === currentMainSuit ? 60000 : 50000;
    if (card.value === '2') return card.suit === currentMainSuit ? 40000 : 30000;
    return (s === 'trump' ? 20000 : 0) + pt;
}

// ！！新增：用于托管挑最小牌的绝对权重 ！！
function getAbsW(card) {
    const sB = {'♠':40,'♥':30,'♣':20,'♦':10};
    const pt = {'4':4,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[card.value]||0;
    if(card.value === '5') return card.suit === currentMainSuit ? 1000 : 900;
    if(card.value === '大王') return 800; if(card.value === '小王') return 700;
    if(card.value === '3') return card.suit === currentMainSuit ? 600 : 500;
    if(card.value === '2') return card.suit === currentMainSuit ? 400 : 300;
    if(card.suit === currentMainSuit) return 200 + pt;
    return sB[card.suit] + pt;
}

// ！！核心：超时托管代打引擎 ！！
function autoPlay(pIndex) {
    emitSys(`玩家[${seats[pIndex].nickname}]超时，系统触发托管代打！`);
    let hand = hands[pIndex];
    if(!hand || hand.length === 0) return;

    // 按绝对牌力从小到大排序
    hand.sort((a,b) => getAbsW(a) - getAbsW(b));
    
    let requiredCount = currentTrick.length > 0 ? currentTrick[0].cards.length : 1;
    let cardsToPlay = [];

    if (currentTrick.length > 0) {
        let leadSuit = getEffectiveSuit(currentTrick[0].cards[0]);
        let matchingCards = hand.filter(c => getEffectiveSuit(c) === leadSuit);
        
        if (matchingCards.length >= requiredCount) {
            // 有同花色，挑最小的
            cardsToPlay = matchingCards.slice(0, requiredCount);
        } else {
            // 没同花色，随便挑手里最小的垫牌
            cardsToPlay = hand.slice(0, requiredCount);
        }
    } else {
        // 首发超时，挑最小的
        cardsToPlay = hand.slice(0, requiredCount);
    }

    // 从手牌剔除
    cardsToPlay.forEach(c => {
        let idx = hand.findIndex(hc => hc.suit === c.suit && hc.value === c.value);
        if(idx !== -1) hand.splice(idx, 1);
    });

    handlePlayCards(pIndex, cardsToPlay);
    // 通知该玩家的手牌已被服务器强行修改
    if(seats[pIndex]) io.to(seats[pIndex].id).emit('initHand', hand);
}

// ==========================================
// 游戏流转逻辑
// ==========================================
function startNewGame() {
    matchConfig.currentGame++; offStageScore = 0; tricksPlayed = 0; drawCount = 0;
    currentMainSuit = '?'; isTrumpOverridden = false; currentTrick = []; targetCard = null;
    wantStatus = { p1: null, p2: null }; hands = [[],[],[],[]];
    deck = [];
    const suits = ['♠', '♥', '♣', '♦'], values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    for (let i = 0; i < 2; i++) {
        suits.forEach(s => values.forEach(v => deck.push({ suit: s, value: v })));
        deck.push({ suit: 'Joker', value: '小王' }, { suit: 'Joker', value: '大王' });
    }
    deck.sort(() => Math.random() - 0.5);

    if (matchConfig.currentGame === 1) {
        teamOnStage = []; 
        let revIdx = deck.findIndex(c => c.suit !== 'Joker');
        targetCard = deck.splice(revIdx, 1)[0]; currentMainSuit = targetCard.suit;
        deck.splice(Math.floor(Math.random() * 60) + 20, 0, targetCard);
        currentTurnIndex = Math.floor(Math.random() * 4); 
        emitSys(`第一局！牌堆翻开 [${currentMainSuit}${targetCard.value}]，抓到者即为庄家！`);
    } else {
        currentTurnIndex = teamOnStage.length > 0 ? teamOnStage[Math.floor(Math.random()*2)] : Math.floor(Math.random() * 4);
        emitSys(`第 ${matchConfig.currentGame} 局开始！`);
    }
    
    gameState = 'DRAWING';
    io.emit('hideLobby'); broadcastGameState(); triggerNextDraw();
}

function triggerNextDraw() {
    io.emit('deckSync', { remain: 108 - drawCount, target: matchConfig.currentGame === 1 ? targetCard : null });
    if (drawCount >= 100) {
        bottomCards = deck.splice(0, 8); io.emit('deckSync', { remain: 0, target: null });
        if (matchConfig.currentGame === 1) {
            gameState = 'BURYING'; currentTurnIndex = teamOnStage[0]; broadcastGameState();
            io.emit('showPub', bottomCards);
            emitSys(`底牌归属庄家。展示3秒...`);
            setTimeout(() => {
                io.emit('clearPub'); emitSys(`请庄家扣底（限时45秒）`); 
                io.emit('takeBottomSig', currentTurnIndex);
            }, 3000);
        } else {
            gameState = 'POST_DRAW'; broadcastGameState(); emitSys("3秒最后亮主机会...");
            startTimer(3, () => {
                if (currentMainSuit === '?') {
                    let maxV = -1, bestS = '♠';
                    bottomCards.forEach(c => {
                        let v = {'4':4,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[c.value]||0;
                        if(c.suit!=='Joker' && v>maxV) { maxV=v; bestS=c.suit; }
                    });
                    currentMainSuit = bestS; emitSys(`强制定主[${currentMainSuit}]`);
                }
                startNegotiation();
            });
        }
        return;
    }
    io.emit('turnUpd', currentTurnIndex);
    startTimer(1.5, () => { 
        let c = deck.shift(); hands[currentTurnIndex].push(c); drawCount++;
        if(seats[currentTurnIndex]) io.to(seats[currentTurnIndex].id).emit('drawResp', c);
        if (matchConfig.currentGame === 1 && targetCard && c.suit === targetCard.suit && c.value === targetCard.value) {
            if (teamOnStage.length === 0) {
                teamOnStage = [currentTurnIndex, (currentTurnIndex + 2) % 4]; targetCard = null; 
                emitSys(`🎉 [${seats[currentTurnIndex].nickname}] 抓到天命牌成为庄家！`); broadcastGameState();
            }
        }
        currentTurnIndex = (currentTurnIndex + 1) % 4; triggerNextDraw();
    });
}

function startNegotiation() {
    gameState = 'NEGOTIATING'; broadcastGameState();
    io.emit('showPub', bottomCards); emitSys("台上玩家6秒内协商要底牌...");
    startTimer(6, () => {
        let p1 = teamOnStage[0], p2 = teamOnStage[1];
        if (wantStatus.p1 && !wantStatus.p2) currentTurnIndex = p1;
        else if (!wantStatus.p1 && wantStatus.p2) currentTurnIndex = p2;
        else currentTurnIndex = teamOnStage[Math.floor(Math.random()*2)];
        io.emit('clearPub'); gameState = 'BURYING'; broadcastGameState();
        emitSys(`请 [${seats[currentTurnIndex].nickname}] 扣底！`);
        io.emit('takeBottomSig', currentTurnIndex);
    });
}

function handlePlayCards(pIndex, cards) {
    clearTimeout(turnTimer); 
    currentTrick.push({ idx: pIndex, cards });
    io.emit('playerPlayed', { idx: pIndex, cards });
    
    if (currentTrick.length === 4) {
        tricksPlayed++;
        let leadSuit = getEffectiveSuit(currentTrick[0].cards[0]);
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
            emitSys(`局终！台下得分：${offStageScore}。8秒后下一局...`);
            setTimeout(startNewGame, 8000);
            return;
        }
        
        emitSys(`本轮结束，玩家[${seats[winIdx].nickname}] 大。`);
        setTimeout(() => { 
            currentTrick = []; currentTurnIndex = winIdx; 
            io.emit('clearTable'); io.emit('turnUpd', winIdx); 
            emitSys(`请 [${seats[winIdx].nickname}] 出牌`);
            startTimer(30, () => autoPlay(winIdx)); // 赢家首发 30 秒倒计时
        }, 2000);
    } else {
        currentTurnIndex = (currentTurnIndex + 1) % 4; 
        io.emit('turnUpd', currentTurnIndex); 
        startTimer(30, () => autoPlay(currentTurnIndex)); // 跟牌 30 秒倒计时
    }
}

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
    
    emitSys(`[${socket.nickname}] 进入房间`); broadcastRoomState();

    socket.on('disconnect', () => {
        if (socket.isSpectator) spectators = spectators.filter(s => s.id !== socket.id);
        else {
            seats[socket.seatIndex] = null; emitSys(`[${socket.nickname}] 退出`);
            if (socket.isOwner) {
                let nextPlayer = seats.find(s => s !== null);
                if (nextPlayer) { nextPlayer.isOwner = true; roomOwnerId = nextPlayer.id; }
                else roomOwnerId = null;
            }
            if (gameState !== 'LOBBY') {
                gameState = 'LOBBY'; clearTimeout(turnTimer); emitSys("⚠️ 有人掉线，返回大厅。");
                seats.forEach(s => { if(s) s.isReady = false; }); io.emit('showLobbyFallback'); 
            }
        }
        broadcastRoomState();
    });

    socket.on('toggleReady', () => { if (!socket.isOwner && !socket.isSpectator && gameState === 'LOBBY') { socket.isReady = !socket.isReady; broadcastRoomState(); }});
    socket.on('startGame', (len) => {
        if (socket.isOwner && gameState === 'LOBBY') {
            let readyCount = seats.filter(s => s !== null && (s.isReady || s.isOwner)).length;
            if (seats.filter(s => s !== null).length === 4 && readyCount === 4) { matchConfig.totalGames = parseInt(len); startNewGame(); } 
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
            io.emit('turnUpd', currentTurnIndex); 
            emitSys(`出牌阶段开始！请 [${seats[currentTurnIndex].nickname}] 出牌`);
            startTimer(30, () => autoPlay(currentTurnIndex)); // 第一手出牌 30 秒倒计时
        }, 3000);
    });

    socket.on('playCards', (cards) => {
        // 客户端发来的合法出牌，直接交给 handle 处理
        handlePlayCards(socket.seatIndex, cards);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => { console.log(`云端服务器已启动端口 ${PORT}`); });
