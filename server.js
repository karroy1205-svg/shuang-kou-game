const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname));

// ==========================================
// 全局数据 (单一数据源，修复重复声明)
// ==========================================
let players = []; 
let matchConfig = { totalGames: 5, currentGame: 0, team1Wins: 0, team2Wins: 0 };
let teamOnStage = [0, 2]; // 默认1、3为台上的队伍1
let gameState = 'WAITING'; // WAITING, DRAWING, NEGOTIATING, BURYING, PLAYING
let deck = [], bottomCards = [], hands = [[], [], [], []];
let currentMainSuit = '?', isTrumpOverridden = false;
let currentTurnIndex = 0, drawCount = 0;
let currentTrick = [], offStageScore = 0, tricksPlayed = 0;
let wantStatus = { p1: null, p2: null }; 
let turnTimer = null;

function emitSys(msg) { io.emit('systemMsg', msg); }
function startTimer(sec, cb) { 
    clearTimeout(turnTimer); io.emit('startTimer', sec);
    turnTimer = setTimeout(cb, sec * 1000);
}
function broadcastState() {
    io.emit('stateSync', { match: matchConfig, onStage: teamOnStage, state: gameState, mainSuit: currentMainSuit, score: offStageScore });
}

// 核心比大小权重
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
// 逻辑引擎
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
        // 首局自动定主发牌
        let rev = deck.find(c => c.suit !== 'Joker'); currentMainSuit = rev.suit;
        let zhuang = -1;
        players.forEach((p, i) => {
            hands[i] = deck.splice(0, 25);
            if (hands[i].some(c => c.suit === rev.suit && c.value === rev.value)) zhuang = i;
            io.to(p.id).emit('initHand', hands[i]);
        });
        teamOnStage = [zhuang, (zhuang + 2) % 4]; currentTurnIndex = zhuang;
        gameState = 'BURYING'; broadcastState();
        emitSys(`第一局自动定主[${currentMainSuit}]。展示底牌3秒...`);
        io.emit('showPub', bottomCards);
        setTimeout(() => { io.emit('clearPub'); io.emit('takeBottomSig', currentTurnIndex); }, 3000);
    } else {
        // 后续局单张摸牌
        gameState = 'DRAWING';
        currentTurnIndex = teamOnStage[Math.floor(Math.random()*2)];
        broadcastState(); triggerNextDraw();
    }
}

function triggerNextDraw() {
    if (drawCount >= 100) {
        gameState = 'POST_DRAW'; broadcastState();
        emitSys("摸牌结束。无人亮3则3秒后定主...");
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
        io.to(players[currentTurnIndex].id).emit('drawResp', c);
        currentTurnIndex = (currentTurnIndex + 1) % 4; triggerNextDraw();
    });
}

function startNegotiation() {
    gameState = 'NEGOTIATING'; broadcastState();
    io.emit('showPub', bottomCards); emitSys("请台上玩家在6秒内协商要牌...");
    startTimer(6, () => {
        let p1 = teamOnStage[0], p2 = teamOnStage[1];
        if (wantStatus.p1 && !wantStatus.p2) currentTurnIndex = p1;
        else if (!wantStatus.p1 && wantStatus.p2) currentTurnIndex = p2;
        else currentTurnIndex = teamOnStage[Math.floor(Math.random()*2)];
        io.emit('clearPub'); gameState = 'BURYING'; broadcastState();
        io.emit('takeBottomSig', currentTurnIndex);
    });
}

io.on('connection', (socket) => {
    if (players.length >= 4) return;
    players.push(socket);
    if (socket.playerIndex === undefined) socket.playerIndex = players.length - 1;
    if (players.length === 1) io.to(socket.id).emit('showLobby');
    if (players.length === 4) emitSys("人员齐备，等待房主开始...");

    socket.on('startMatch', (len) => { matchConfig.totalGames = parseInt(len); io.emit('hideLobby'); startNewGame(); });
    socket.on('callTrump', (s) => { if(currentMainSuit==='?'){ currentMainSuit=s; broadcastState(); emitSys(`玩家${socket.playerIndex+1}亮3定主[${s}]`); }});
    socket.on('overrideTrump', (s) => { if(!isTrumpOverridden){ currentMainSuit=s; isTrumpOverridden=true; broadcastState(); emitSys(`🔥 玩家${socket.playerIndex+1}双3反主[${s}]！`); }});
    socket.on('toggleWant', (w) => { if(socket.playerIndex===teamOnStage[0]) wantStatus.p1=w; if(socket.playerIndex===teamOnStage[1]) wantStatus.p2=w; });
    socket.on('takeBottomAck', () => { io.to(socket.id).emit('recvBottom', bottomCards); emitSys("庄家正在扣底..."); startTimer(45, ()=>{}); });
    
    socket.on('buryCards', (cards) => {
        clearTimeout(turnTimer); bottomCards = cards;
        io.emit('showPub', bottomCards); emitSys("展示扣底牌3秒...");
        setTimeout(() => {
            io.emit('clearPub'); gameState = 'PLAYING'; broadcastState();
            io.emit('turnUpd', currentTurnIndex); startTimer(15, ()=>{});
        }, 3000);
    });

    socket.on('playCards', (cards) => {
        clearTimeout(turnTimer); currentTrick.push({ idx: socket.playerIndex, cards });
        io.emit('playerPlayed', { idx: socket.playerIndex, cards });
        if (currentTrick.length === 4) {
            tricksPlayed++;
            let leadSuit = (currentTrick[0].cards[0].suit==='Joker'||['5','3','2'].includes(currentTrick[0].cards[0].value)||currentTrick[0].cards[0].suit===currentMainSuit)?'trump':currentTrick[0].cards[0].suit;
            let hiW = -1, winIdx = -1, pts = 0;
            currentTrick.forEach(p => {
                pts += p.cards.reduce((sum, c) => sum + (c.value === '5' ? 5 : (['10','K'].includes(c.value) ? 10 : 0)), 0);
                let w = getW(p.cards[0], leadSuit);
                if (w > hiW) { hiW = w; winIdx = p.idx; }
            });
            if (!teamOnStage.includes(winIdx)) { offStageScore += pts; broadcastState(); }
            
            if (tricksPlayed === 25) {
                if (!teamOnStage.includes(winIdx)) offStageScore += bottomCards.reduce((sum, c) => sum + (c.value === '5' ? 5 : (['10','K'].includes(c.value) ? 10 : 0)), 0);
                broadcastState();
                let winTeam1 = (offStageScore < 80);
                if (teamOnStage.includes(0)) { if(winTeam1) matchConfig.team1Wins++; else { matchConfig.team2Wins++; teamOnStage=[1,3]; } }
                else { if(!winTeam1) matchConfig.team2Wins++; else { matchConfig.team1Wins++; teamOnStage=[0,2]; } }
                emitSys(`局终！台下拿了${offStageScore}分。10秒后重开。`);
                setTimeout(startNewGame, 10000);
                return;
            }
            setTimeout(() => { currentTrick = []; currentTurnIndex = winIdx; io.emit('clearTable'); io.emit('turnUpd', winIdx); startTimer(15, ()=>{}); }, 2000);
        } else {
            currentTurnIndex = (currentTurnIndex + 1) % 4; io.emit('turnUpd', currentTurnIndex); startTimer(15, ()=>{});
        }
    });
});
server.listen(process.env.PORT || 3000);