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

const baseNicknames = ["海淀赌神", "大铁郭先生", "双扣狂魔", "鲨鱼女神", "绝命毒师", "王子不撑", "键盘刺客", "梅子配酒"];

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
    let cardCounts = hands.map(h => h ? h.length : 0);
    io.emit('gameStateSync', { match: matchConfig, onStage: teamOnStage, state: gameState, mainSuit: currentMainSuit, score: offStageScore, isFirstGame: matchConfig.currentGame === 1, cardCounts: cardCounts });
}

function getEffectiveSuit(card) {
    if (card.suit === 'Joker' || ['5','3','2'].includes(card.value) || card.suit === currentMainSuit) return 'trump';
    return card.suit;
}

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

function autoPlay(pIndex) {
    emitSys(`[${seats[pIndex].nickname}]超时，系统触发托管代打！`);
    let hand = hands[pIndex];
    if(!hand || hand.length === 0) return;

    hand.sort((a,b) => getAbsW(a) - getAbsW(b));
    let cardsToPlay = [];

    if (currentTrick.length === 0) {
        cardsToPlay = [hand[0]]; 
    } else {
        let leadCards = currentTrick[0].cards;
        let leadSuit = getEffectiveSuit(leadCards[0]);
        let handLeadSuitCards = hand.filter(c => getEffectiveSuit(c) === leadSuit);

        if (leadCards.length === 1) {
            if (handLeadSuitCards.length > 0) cardsToPlay = [handLeadSuitCards[0]];
            else cardsToPlay = [hand[0]];
        } else if (leadCards.length === 2) {
            let pairs = [];
            for(let i=0; i<handLeadSuitCards.length-1; i++) {
                if(handLeadSuitCards[i].value === handLeadSuitCards[i+1].value && handLeadSuitCards[i].suit === handLeadSuitCards[i+1].suit) {
                    pairs.push([handLeadSuitCards[i], handLeadSuitCards[i+1]]);
                }
            }
            if (pairs.length > 0) cardsToPlay = pairs[0]; 
            else {
                cardsToPlay = handLeadSuitCards.slice(0, 2);
                let needed = 2 - cardsToPlay.length;
                let otherCards = hand.filter(c => !cardsToPlay.includes(c));
                cardsToPlay = cardsToPlay.concat(otherCards.slice(0, needed));
            }
        }
    }

    cardsToPlay.forEach(c => {
        let idx = hand.findIndex(hc => hc.suit === c.suit && hc.value === c.value);
        if(idx !== -1) hand.splice(idx, 1);
    });

    handlePlayCards(pIndex, cardsToPlay);
    if(seats[pIndex]) io.to(seats[pIndex].id).emit('initHand', hand);
}

function executeDraw(pIndex) {
    if (gameState !== 'DRAWING') return;
    clearTimeout(turnTimer);
    
    let card = deck.shift();
    hands[pIndex].push(card);
    drawCount++;
    broadcastGameState(); 
    if(seats[pIndex]) io.to(seats[pIndex].id).emit('drawResp', card);

    if (matchConfig.currentGame === 1 && targetCard && card.suit === targetCard.suit && card.value === targetCard.value) {
        if (teamOnStage.length === 0) {
            teamOnStage = [pIndex, (pIndex + 2) % 4]; targetCard = null; 
            emitSys(`🎉 [${seats[pIndex].nickname}] 抓到天命牌成为庄家！`); broadcastGameState();
        }
    }
    currentTurnIndex = (currentTurnIndex + 1) % 4;
    triggerNextDraw();
}

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
        emitSys(`第一局开始！[${currentMainSuit}${targetCard.value}]，抓到者为庄！`);
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
            if (teamOnStage.length === 0) {
                teamOnStage = [currentTurnIndex, (currentTurnIndex + 2) % 4];
                emitSys(`天命牌沉底！[${seats[currentTurnIndex].nickname}] 幸运成为庄家！`);
            }
            gameState = 'BURYING_TAKE'; currentTurnIndex = teamOnStage[0]; broadcastGameState();
            io.emit('showPub', bottomCards);
            emitSys(`底牌展示完毕，请庄家拿牌`);
            setTimeout(() => { io.emit('clearPub'); io.emit('takeBottomSig', currentTurnIndex); }, 3000);
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
    startTimer(1, () => { executeDraw(currentTurnIndex); });
}

function startNegotiation() {
    gameState = 'NEGOTIATING'; broadcastGameState();
    io.emit('showPub', bottomCards); emitSys("台上玩家6秒内协商要底牌...");
    startTimer(6, () => {
        let p1 = teamOnStage[0], p2 = teamOnStage[1];
        if (wantStatus.p1 && !wantStatus.p2) currentTurnIndex = p1;
        else if (!wantStatus.p1 && wantStatus.p2) currentTurnIndex = p2;
        else currentTurnIndex = teamOnStage[Math.floor(Math.random()*2)];
        io.emit('clearPub'); gameState = 'BURYING_TAKE'; broadcastGameState();
        io.emit('takeBottomSig', currentTurnIndex);
    });
}

function handlePlayCards(pIndex, cards) {
    clearTimeout(turnTimer); 
    currentTrick.push({ idx: pIndex, cards });
    broadcastGameState(); 
    io.emit('playerPlayed', { idx: pIndex, cards });
    
    if (currentTrick.length === 4) {
        tricksPlayed++;
        let leadCards = currentTrick[0].cards;
        let leadSuit = getEffectiveSuit(leadCards[0]);
        let isLeadPair = leadCards.length === 2 && leadCards[0].value === leadCards[1].value && leadCards[0].suit === leadCards[1].suit;
        
        let hiW = -1, winIdx = -1, pts = 0;
        
        currentTrick.forEach(p => {
            pts += p.cards.reduce((sum, c) => sum + (c.value === '5' ? 5 : (['10','K'].includes(c.value) ? 10 : 0)), 0);
            let isPair = p.cards.length === 2 && p.cards[0].value === p.cards[1].value && p.cards[0].suit === p.cards[1].suit;
            let w = -1;
            
            if (leadCards.length === 1 && p.cards.length === 1) w = getW(p.cards[0], leadSuit);
            else if (isLeadPair && isPair) w = getW(p.cards[0], leadSuit);
            
            if (w > hiW) { hiW = w; winIdx = p.idx; }
        });
        
        if (!teamOnStage.includes(winIdx)) { offStageScore += pts; broadcastGameState(); }
        
        if (tricksPlayed === 25) {
            if (!teamOnStage.includes(winIdx)) offStageScore += bottomCards.reduce((sum, c) => sum + (c.value === '5' ? 5 : (['10','K'].includes(c.value) ? 10 : 0)), 0);
            broadcastGameState();
            let winTeam1 = (offStageScore < 80);
            if (teamOnStage.includes(0)) { if(winTeam1) matchConfig.team1Wins++; else { matchConfig.team2Wins++; teamOnStage=[1,3]; } }
            else { if(!winTeam1) matchConfig.team2Wins++; else { matchConfig.team1Wins++; teamOnStage=[0,2]; } }
            
            if (matchConfig.currentGame >= matchConfig.totalGames) {
                emitSys(`🏆 比赛结束！总胜场: [队1] ${matchConfig.team1Wins} - ${matchConfig.team2Wins} [队2]`);
                setTimeout(() => {
                    gameState = 'LOBBY'; clearTimeout(turnTimer);
                    seats.forEach(s => { if(s) s.isReady = false; });
                    io.emit('showLobbyFallback'); broadcastRoomState();
                }, 8000);
            } else {
                emitSys(`局终！台下得分：${offStageScore}。8秒后下一局...`);
                setTimeout(startNewGame, 8000);
            }
            return;
        }
        
        emitSys(`本轮结束，[${seats[winIdx].nickname}] 大。`);
        setTimeout(() => { 
            currentTrick = []; currentTurnIndex = winIdx; 
            io.emit('clearTable'); io.emit('turnUpd', winIdx); 
            emitSys(`请 [${seats[winIdx].nickname}] 出牌`);
            startTimer(30, () => autoPlay(winIdx)); 
        }, 2000);
    } else {
        currentTurnIndex = (currentTurnIndex + 1) % 4; 
        io.emit('turnUpd', currentTurnIndex); 
        startTimer(30, () => autoPlay(currentTurnIndex)); 
    }
}

io.on('connection', (socket) => {
    socket.baseName = baseNicknames[Math.floor(Math.random() * baseNicknames.length)];
    socket.nickname = socket.baseName; 
    socket.isReady = false; socket.isOwner = false;

    let emptyIdx = seats.findIndex(s => s === null);
    if (emptyIdx !== -1 && gameState === 'LOBBY') {
        socket.seatIndex = emptyIdx; seats[emptyIdx] = socket;
        socket.nickname = `【${emptyIdx + 1}号${socket.baseName}】`; 
        if (!roomOwnerId) { roomOwnerId = socket.id; socket.isOwner = true; }
        io.to(socket.id).emit('seatAssigned', { seatIndex: emptyIdx, nickname: socket.nickname, isOwner: socket.isOwner });
    } else {
        socket.isSpectator = true; spectators.push(socket); io.to(socket.id).emit('spectatorMode', socket.nickname);
    }
    
    emitSys(`[${socket.nickname}] 进入房间`); broadcastRoomState();

    socket.on('disconnect', () => {
        if (socket.isSpectator) spectators = spectators.filter(s => s.id !== socket.id);
        else {
            seats[socket.seatIndex] = null; emitSys(`[${socket.nickname}] 退出`);
            if (socket.isOwner) {
                let nextPlayer = seats.find(s => s !== null);
                if (nextPlayer) { 
                    nextPlayer.isOwner = true; roomOwnerId = nextPlayer.id; 
                    io.to(nextPlayer.id).emit('ownerChanged', true); 
                } else roomOwnerId = null;
            }
            if (gameState !== 'LOBBY') {
                gameState = 'LOBBY'; clearTimeout(turnTimer); emitSys("⚠️ 有人掉线，比赛中断返回大厅。");
                seats.forEach(s => { if(s) s.isReady = false; }); io.emit('showLobbyFallback'); 
            }
        }
        broadcastRoomState();
    });

    socket.on('kickPlayer', targetId => {
        if (socket.isOwner && gameState === 'LOBBY') {
            let tSocket = io.sockets.sockets.get(targetId);
            if (tSocket) { emitSys(`👢 [${tSocket.nickname}] 被房主移出房间`); tSocket.disconnect(); }
        }
    });

    socket.on('transferOwner', targetId => {
        if (socket.isOwner && gameState === 'LOBBY') {
            let targetSocket = seats.find(s => s && s.id === targetId);
            if (targetSocket) {
                socket.isOwner = false; targetSocket.isOwner = true; roomOwnerId = targetSocket.id;
                io.to(socket.id).emit('ownerChanged', false);
                io.to(targetSocket.id).emit('ownerChanged', true);
                emitSys(`👑 房主权限已移交给 [${targetSocket.nickname}]`);
                broadcastRoomState();
            }
        }
    });

    socket.on('toggleReady', () => { if (!socket.isOwner && !socket.isSpectator && gameState === 'LOBBY') { socket.isReady = !socket.isReady; broadcastRoomState(); }});
    socket.on('startGame', (config) => {
        if (socket.isOwner && gameState === 'LOBBY') {
            let readyCount = seats.filter(s => s !== null && (s.isReady || s.isOwner)).length;
            if (seats.filter(s => s !== null).length === 4 && readyCount === 4) { 
                matchConfig.totalGames = parseInt(config.len); 
                if (config.reset) {
                    matchConfig.currentGame = 0; matchConfig.team1Wins = 0; matchConfig.team2Wins = 0; offStageScore = 0;
                }
                startNewGame(); 
            } 
        }
    });

    socket.on('reqDraw', () => { if (socket.seatIndex === currentTurnIndex) executeDraw(socket.seatIndex); });
    socket.on('callTrump', (s) => { if(currentMainSuit==='?' && matchConfig.currentGame > 1){ currentMainSuit=s; broadcastGameState(); emitSys(`[${socket.nickname}]亮3定主[${s}]`); }});
    socket.on('overrideTrump', (s) => { if(!isTrumpOverridden && matchConfig.currentGame > 1){ currentMainSuit=s; isTrumpOverridden=true; broadcastGameState(); emitSys(`🔥 [${socket.nickname}]双3反主[${s}]！`); }});
    socket.on('toggleWant', (w) => { if(socket.seatIndex===teamOnStage[0]) wantStatus.p1=w; if(socket.seatIndex===teamOnStage[1]) wantStatus.p2=w; });
    
    socket.on('takeBottomAck', () => { 
        hands[socket.seatIndex].push(...bottomCards);
        gameState = 'BURYING_ACTION'; broadcastGameState();
        io.to(socket.id).emit('recvBottom', bottomCards); 
        emitSys("庄家正在选牌扣底 (限时45秒)..."); 
        startTimer(45, () => {
            let hand = hands[socket.seatIndex]; hand.sort((a,b) => getAbsW(a) - getAbsW(b));
            bottomCards = hand.splice(0, 8); io.emit('showPub', bottomCards);
            emitSys(`扣底超时，系统自动扣除8张最小牌！展示3秒...`);
            setTimeout(() => {
                io.emit('clearPub'); gameState = 'PLAYING'; broadcastGameState(); io.emit('turnUpd', currentTurnIndex);
                emitSys(`出牌阶段开始！请 [${seats[currentTurnIndex].nickname}] 出牌`);
                startTimer(30, () => autoPlay(currentTurnIndex));
            }, 3000);
        }); 
    });
    
    socket.on('buryCards', (cards) => {
        clearTimeout(turnTimer); bottomCards = cards.buried; hands[socket.seatIndex] = cards.leftoverHand; 
        io.emit('showPub', bottomCards); emitSys("扣底完成，展示3秒...");
        setTimeout(() => {
            io.emit('clearPub'); gameState = 'PLAYING'; broadcastGameState(); io.emit('turnUpd', currentTurnIndex); 
            emitSys(`出牌阶段开始！请 [${seats[currentTurnIndex].nickname}] 出牌`);
            startTimer(30, () => autoPlay(currentTurnIndex)); 
        }, 3000);
    });

    socket.on('playCards', (cards) => { hands[socket.seatIndex] = cards.leftoverHand; handlePlayCards(socket.seatIndex, cards.played); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => { console.log(`云端服务器已启动`); });
