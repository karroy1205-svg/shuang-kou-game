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
let wantStatus = [false, false, false, false]; 
let turnTimer = null;
let targetCard = null; 

let tributeConfig = { needsTribute: 0, payers: [], receivers: [], paidCards: [], returnedFrom: [] }; 
let settlementAcks = [];

const baseNicknames = ["海淀赌神", "朝阳群众", "双扣狂魔", "摸鱼达人", "绝命毒师", "天选之子", "键盘刺客", "西二旗卷王"];

function emitSys(msg) { io.emit('systemMsg', msg); }

function startTimer(sec, cb) { 
    clearTimeout(turnTimer); io.emit('startTimer', sec);
    turnTimer = setTimeout(cb, sec * 1000);
}

function promptPlay(pIdx) {
    currentTurnIndex = pIdx;
    io.emit('turnUpd', pIdx);
    let seat = seats[pIdx];
    
    if (seat && seat.isOffline) {
        emitSys(`🤖 [${seat.nickname}] 托管中，倒计时2秒...`);
        startTimer(2, () => autoPlay(pIdx));
    } else {
        let name = seat ? seat.nickname : '玩家';
        emitSys(`请 [${name}] 出牌`);
        startTimer(30, () => autoPlay(pIdx));
    }
}

function broadcastRoomState() {
    let roomData = seats.map(s => s ? { id: s.id, name: s.nickname, isReady: s.isReady, isOwner: s.isOwner, isOffline: s.isOffline } : null);
    io.emit('roomStateSync', { seats: roomData, spectatorsCount: spectators.length, state: gameState });
}

function broadcastGameState() {
    let cardCounts = hands.map(h => h ? h.length : 0);
    // 生成非常清晰的队伍名单：一三号位组队，二四号位组队
    let t1Names = `[${seats[0]?seats[0].nickname:"空座"} & ${seats[2]?seats[2].nickname:"空座"}]`;
    let t2Names = `[${seats[1]?seats[1].nickname:"空座"} & ${seats[3]?seats[3].nickname:"空座"}]`;
    
    io.emit('gameStateSync', { 
        match: matchConfig, onStage: teamOnStage, state: gameState, 
        mainSuit: currentMainSuit, score: offStageScore, isFirstGame: matchConfig.currentGame === 1, 
        cardCounts: cardCounts, t1Names: t1Names, t2Names: t2Names 
    });
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
    let seat = seats[pIndex];
    if (!seat || !seat.isOffline) emitSys(`⏳ [${seat ? seat.nickname : '玩家'}] 出牌超时，强制代打！`);
    
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

    let actualPlayed = [];
    cardsToPlay.forEach(c => {
        let idx = hand.findIndex(hc => hc.suit === c.suit && hc.value === c.value);
        if(idx !== -1) actualPlayed.push(hand.splice(idx, 1)[0]);
    });

    handlePlayCards(pIndex, actualPlayed);
    let realPlayerSocket = seats[pIndex];
    if(realPlayerSocket && !realPlayerSocket.isOffline) io.to(realPlayerSocket.id).emit('initHand', hand);
}

function executeDraw(pIndex) {
    if (gameState !== 'DRAWING') return;
    clearTimeout(turnTimer);
    
    let card = deck.shift();
    hands[pIndex].push(card);
    drawCount++;
    broadcastGameState(); 
    let realPlayerSocket = seats[pIndex];
    if(realPlayerSocket && !realPlayerSocket.isOffline) io.to(realPlayerSocket.id).emit('drawResp', card);

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
    wantStatus = [false, false, false, false]; settlementAcks = []; hands = [[],[],[],[]];
    tributeConfig = { needsTribute: 0, payers: [], receivers: [], paidCards: [], returnedFrom: [] };
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
    io.emit('hideLobby'); io.emit('hideSettlement'); broadcastGameState(); triggerNextDraw();
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
            io.emit('takeBottomSig', currentTurnIndex);
            emitSys(`请庄家拿取底牌`);
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
    startTimer(0.5, () => { executeDraw(currentTurnIndex); });
}

function startNegotiation() {
    gameState = 'NEGOTIATING'; broadcastGameState();
    emitSys("台上玩家6秒内点击按钮要底牌(可取消)...");
    startTimer(6, () => {
        let p1 = teamOnStage[0], p2 = teamOnStage[1];
        if (wantStatus[p1] && !wantStatus[p2]) currentTurnIndex = p1;
        else if (!wantStatus[p1] && wantStatus[p2]) currentTurnIndex = p2;
        else currentTurnIndex = teamOnStage[Math.floor(Math.random()*2)];
        gameState = 'BURYING_TAKE'; broadcastGameState();
        io.emit('takeBottomSig', currentTurnIndex);
    });
}

function proceedAfterBury() {
    if (tributeConfig.needsTribute > 0) {
        gameState = 'TRIBUTE_PAY'; broadcastGameState();
        let payerNames = tributeConfig.payers.map(i => seats[i] ? seats[i].nickname : '玩家').join(' 和 ');
        emitSys(`⚠️ 进贡阶段！请 ${payerNames} 在10秒内选最大主牌进贡！`);
        io.emit('startTributePhase', { phase: 'PAY', payers: tributeConfig.payers });
        
        startTimer(10, () => {
            tributeConfig.payers.forEach((pIdx) => {
                let alreadyPaid = tributeConfig.paidCards.some(pc => pc.from === pIdx);
                if (!alreadyPaid && hands[pIdx].length > 0) {
                    hands[pIdx].sort((a,b) => getAbsW(b) - getAbsW(a)); 
                    let paidCard = hands[pIdx].splice(0, 1)[0];
                    processPaidTribute(pIdx, paidCard);
                }
            });
        });
    } else {
        gameState = 'PLAYING'; broadcastGameState(); 
        promptPlay(currentTurnIndex);
    }
}

function processPaidTribute(pIdx, card) {
    let tIdx = tributeConfig.payers.indexOf(pIdx);
    if (tIdx !== -1 && tributeConfig.paidCards.length <= tIdx) {
        let receiverIdx = tributeConfig.receivers[tIdx];
        tributeConfig.paidCards.push({ from: pIdx, to: receiverIdx, card: card });
        emitSys(`[${seats[pIdx].nickname}] 进贡了 ${card.suit}${card.value}`);
        io.to(seats[pIdx].id).emit('initHand', hands[pIdx]);
        
        if (tributeConfig.paidCards.length === 2) {
            tributeConfig.paidCards.forEach(p => hands[p.to].push(p.card));
            tributeConfig.receivers.forEach(r => io.to(seats[r].id).emit('initHand', hands[r]));
            
            clearTimeout(turnTimer);
            gameState = 'TRIBUTE_RETURN'; broadcastGameState();
            emitSys(`✅ 进贡完成！请收供者在20秒内选最小牌还供！`);
            io.emit('startTributePhase', { phase: 'RETURN', receivers: tributeConfig.receivers });
            
            startTimer(20, () => {
                tributeConfig.receivers.forEach((rIdx) => {
                    if (!tributeConfig.returnedFrom.includes(rIdx)) {
                        hands[rIdx].sort((a,b) => getAbsW(a) - getAbsW(b)); 
                        let retCard = hands[rIdx].splice(0, 1)[0];
                        processReturnedTribute(rIdx, retCard);
                    }
                });
            });
        }
    }
}

function processReturnedTribute(rIdx, card) {
    if (tributeConfig.returnedFrom.includes(rIdx)) return;
    let tIdx = tributeConfig.receivers.indexOf(rIdx);
    if (tIdx !== -1) {
        tributeConfig.returnedFrom.push(rIdx);
        let payerIdx = tributeConfig.payers[tIdx];
        hands[payerIdx].push(card);
        emitSys(`[${seats[rIdx].nickname}] 还供了 ${card.suit}${card.value}`);
        io.to(seats[rIdx].id).emit('initHand', hands[rIdx]);
        io.to(seats[payerIdx].id).emit('initHand', hands[payerIdx]);

        if (tributeConfig.returnedFrom.length === 2) {
            clearTimeout(turnTimer);
            emitSys(`🎉 还供完毕！出牌阶段开始！`);
            gameState = 'PLAYING'; broadcastGameState();
            promptPlay(currentTurnIndex);
        }
    }
}

function handlePlayCards(pIndex, cards) {
    clearTimeout(turnTimer); 
    if (tricksPlayed === 0 && currentTrick.length === 0) io.emit('clearPub');

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
        
        emitSys(`本轮结束，[${seats[winIdx].nickname}] 大。`);

        let isGameOver = hands.every(h => h.length === 0);
        
        if (isGameOver) {
            setTimeout(() => {
                let offStageTeam = [0,1,2,3].filter(i => !teamOnStage.includes(i));
                let offStageWonLast = !teamOnStage.includes(winIdx);
                let isLastPair = currentTrick.find(t => t.idx === winIdx).cards.length === 2;
                
                // 【修复：废除翻倍，回归纯正扣底加分】只加原始 5/10/K 的分数
                if (offStageWonLast) {
                    let bottomPts = bottomCards.reduce((sum, c) => sum + (c.value === '5' ? 5 : (['10','K'].includes(c.value) ? 10 : 0)), 0);
                    offStageScore += bottomPts;
                }
                
                let nextOnStage = teamOnStage;
                let willTribute = 1; // 1: 台下进贡, 2: 台上进贡, 0: 免供

                if (offStageScore >= 120) { nextOnStage = offStageTeam; willTribute = 2; }
                else if (offStageScore >= 80) { nextOnStage = offStageTeam; willTribute = 0; }
                else if (offStageScore >= 20) { nextOnStage = teamOnStage; willTribute = 0; }
                else { nextOnStage = teamOnStage; willTribute = 1; }

                let kouDiMsg = "";
                if (offStageWonLast) {
                    if (isLastPair) {
                        kouDiMsg = "💥 最后一击【双对抠底】！台下组强制上台且吃供！";
                        nextOnStage = offStageTeam; willTribute = 2;
                    } else {
                        kouDiMsg = "💥 最后一击【单张抠底】！台下组强制上台！";
                        nextOnStage = offStageTeam; 
                        if(willTribute === 1) willTribute = 0; // 成功上台，直接免去因为分数低要进贡的惩罚
                    }
                }

                if (nextOnStage.includes(0)) matchConfig.team1Wins++; else matchConfig.team2Wins++;

                tributeConfig.needsTribute = willTribute;
                if (willTribute === 1) { tributeConfig.payers = offStageTeam; tributeConfig.receivers = nextOnStage; }
                else if (willTribute === 2) { tributeConfig.payers = teamOnStage; tributeConfig.receivers = nextOnStage; }
                
                teamOnStage = nextOnStage; 
                broadcastGameState();

                let stageStr = teamOnStage.map(i=>seats[i]?seats[i].nickname:"").join(', ');
                let settleHTML = `
                    <div style="font-size:20px; font-weight:bold; margin-bottom:10px; color:#e74c3c;">${kouDiMsg}</div>
                    🔥 最终台下得分：<b style="color:#e74c3c; font-size:28px;">${offStageScore}</b> 分<br>
                    🛡️ 下局庄家阵营：<b style="color:#f1c40f;">${stageStr}</b><br>
                    🎁 下局是否进贡：<b style="color:#3498db;">${willTribute===0?'免供':(willTribute===1?'台下进贡':'台上进贡')}</b>
                `;

                if (matchConfig.currentGame >= matchConfig.totalGames) {
                    emitSys(`🏆 比赛结束！总胜场: [队1] ${matchConfig.team1Wins} - ${matchConfig.team2Wins} [队2]`);
                    setTimeout(() => {
                        gameState = 'LOBBY'; clearTimeout(turnTimer);
                        seats.forEach(s => { if(s) { s.isReady = false; }});
                        io.emit('showLobbyFallback'); broadcastRoomState();
                    }, 8000);
                } else {
                    // 【核心修复防卡死：自动帮托管掉线的人点确认！】
                    gameState = 'SETTLEMENT'; clearTimeout(turnTimer);
                    settlementAcks = [];
                    seats.forEach((s, idx) => {
                        if (!s || s.isOffline) settlementAcks.push(idx);
                    });
                    
                    if (settlementAcks.length >= 4) {
                        startNewGame(); // 万一全掉线了，直接开
                    } else {
                        io.emit('showSettlement', settleHTML);
                    }
                }
            }, 2000);
        } else {
            setTimeout(() => { 
                currentTrick = [];  
                io.emit('clearTable'); 
                promptPlay(winIdx); 
            }, 2000);
        }
    } else {
        promptPlay((currentTurnIndex + 1) % 4); 
    }
}

io.on('connection', (socket) => {
    let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    socket.ip = clientIp;

    let existingOfflineSeatIdx = seats.findIndex(s => s !== null && s.ip === clientIp && s.isOffline);
    if (existingOfflineSeatIdx !== -1 && gameState !== 'LOBBY') {
        socket.seatIndex = existingOfflineSeatIdx;
        socket.baseName = seats[existingOfflineSeatIdx].baseName;
        socket.nickname = seats[existingOfflineSeatIdx].nickname;
        socket.isOwner = seats[existingOfflineSeatIdx].isOwner;
        socket.isOffline = false;
        seats[existingOfflineSeatIdx] = socket; 

        io.to(socket.id).emit('seatAssigned', { seatIndex: socket.seatIndex, nickname: socket.nickname, isOwner: socket.isOwner });
        io.to(socket.id).emit('initHand', hands[socket.seatIndex]);
        io.to(socket.id).emit('hideLobby'); 
        emitSys(`🔄 [${socket.nickname}] 重新连接，恢复对局！`);
        broadcastRoomState(); broadcastGameState();
        
        if (gameState === 'PLAYING' && currentTurnIndex === socket.seatIndex) promptPlay(socket.seatIndex);
    } else {
        socket.baseName = baseNicknames[Math.floor(Math.random() * baseNicknames.length)];
        socket.nickname = socket.baseName; 
        socket.isReady = false; socket.isOwner = false; socket.isOffline = false;

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
    }

    socket.on('disconnect', () => {
        if (socket.isSpectator) spectators = spectators.filter(s => s.id !== socket.id);
        else {
            if (gameState !== 'LOBBY') {
                let seat = seats[socket.seatIndex];
                if(seat) seat.isOffline = true;
                emitSys(`⚠️ [${socket.nickname}] 掉线，已交由系统托管。等待重连...`);
                if (gameState === 'PLAYING' && currentTurnIndex === socket.seatIndex) promptPlay(socket.seatIndex);
                
                if (gameState === 'SETTLEMENT') {
                    if (!settlementAcks.includes(socket.seatIndex)) {
                        settlementAcks.push(socket.seatIndex);
                        if (settlementAcks.length === 4) startNewGame();
                    }
                }
            } else {
                seats[socket.seatIndex] = null; emitSys(`[${socket.nickname}] 退出`);
                if (socket.isOwner) {
                    let nextPlayer = seats.find(s => s !== null && !s.isOffline);
                    if (nextPlayer) { 
                        nextPlayer.isOwner = true; roomOwnerId = nextPlayer.id; 
                        io.to(nextPlayer.id).emit('ownerChanged', true); 
                    } else roomOwnerId = null;
                }
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
                io.to(socket.id).emit('ownerChanged', false); io.to(targetSocket.id).emit('ownerChanged', true);
                emitSys(`👑 房主权限已移交给 [${targetSocket.nickname}]`); broadcastRoomState();
            }
        }
    });

    socket.on('toggleReady', () => { if (!socket.isOwner && !socket.isSpectator && gameState === 'LOBBY') { socket.isReady = !socket.isReady; broadcastRoomState(); }});
    socket.on('startGame', (config) => {
        if (socket.isOwner && gameState === 'LOBBY') {
            let readyCount = seats.filter(s => s !== null && (s.isReady || s.isOwner || s.isOffline)).length;
            if (seats.filter(s => s !== null).length === 4 && readyCount === 4) { 
                matchConfig.totalGames = parseInt(config.len); 
                if (config.reset) { matchConfig.currentGame = 0; matchConfig.team1Wins = 0; matchConfig.team2Wins = 0; offStageScore = 0; }
                startNewGame(); 
            } 
        }
    });

    socket.on('ackSettlement', () => {
        if (!settlementAcks.includes(socket.seatIndex)) {
            settlementAcks.push(socket.seatIndex);
            if (settlementAcks.length === 4) startNewGame();
        }
    });

    socket.on('reqDraw', () => { if (socket.seatIndex === currentTurnIndex) executeDraw(socket.seatIndex); });
    socket.on('callTrump', (s) => { if(currentMainSuit==='?' && matchConfig.currentGame > 1){ currentMainSuit=s; broadcastGameState(); emitSys(`[${socket.nickname}]亮3定主[${s}]`); }});
    socket.on('overrideTrump', (s) => { if(!isTrumpOverridden && matchConfig.currentGame > 1){ currentMainSuit=s; isTrumpOverridden=true; broadcastGameState(); emitSys(`🔥 [${socket.nickname}]双3反主[${s}]！`); }});
    
    socket.on('toggleWant', () => { 
        if(teamOnStage.includes(socket.seatIndex) && gameState === 'NEGOTIATING') {
            wantStatus[socket.seatIndex] = !wantStatus[socket.seatIndex];
            io.to(socket.id).emit('wantStatusSync', wantStatus[socket.seatIndex]);
        }
    });
    
    socket.on('takeBottomAck', () => { 
        hands[socket.seatIndex].push(...bottomCards);
        gameState = 'BURYING_ACTION'; broadcastGameState();
        io.to(socket.id).emit('recvBottom', bottomCards); 
        io.emit('showPub', bottomCards); 
        
        emitSys("庄家正在选牌扣底 (限时45秒)..."); 
        startTimer(45, () => {
            let sHand = hands[socket.seatIndex]; sHand.sort((a,b) => getAbsW(a) - getAbsW(b));
            bottomCards = sHand.splice(0, 8); 
            io.emit('showPub', bottomCards); 
            emitSys(`⏳ 扣底超时，系统自动为您代扣8张最小牌！`);
            io.to(socket.id).emit('initHand', sHand); 
            proceedAfterBury(); 
        }); 
    });
    
    socket.on('buryCards', (cards) => {
        clearTimeout(turnTimer); 
        let sHand = hands[socket.seatIndex];
        let newBottom = [];
        cards.buried.forEach(bc => {
            let idx = sHand.findIndex(c => c.suit === bc.suit && c.value === bc.value);
            if (idx !== -1) newBottom.push(sHand.splice(idx, 1)[0]);
        });
        bottomCards = newBottom; 
        io.emit('showPub', bottomCards); 
        emitSys("扣底完成，展示直至第一张牌打出...");
        proceedAfterBury(); 
    });

    socket.on('payTribute', c => {
        if(gameState === 'TRIBUTE_PAY' && tributeConfig.payers.includes(socket.seatIndex)) {
            let alreadyPaid = tributeConfig.paidCards.some(pc => pc.from === socket.seatIndex);
            if (!alreadyPaid) {
                let sHand = hands[socket.seatIndex];
                let idx = sHand.findIndex(hc => hc.suit === c.suit && hc.value === c.value);
                if(idx !== -1) processPaidTribute(socket.seatIndex, sHand.splice(idx, 1)[0]);
            }
        }
    });

    socket.on('returnTribute', c => {
        if(gameState === 'TRIBUTE_RETURN' && tributeConfig.receivers.includes(socket.seatIndex)) {
            let sHand = hands[socket.seatIndex];
            let idx = sHand.findIndex(hc => hc.suit === c.suit && hc.value === c.value);
            if(idx !== -1) processReturnedTribute(socket.seatIndex, sHand.splice(idx, 1)[0]);
        }
    });

    socket.on('playCards', (cards) => { 
        let sHand = hands[socket.seatIndex]; let actualPlayed = [];
        cards.played.forEach(pc => {
            let idx = sHand.findIndex(c => c.suit === pc.suit && c.value === pc.value);
            if(idx !== -1) actualPlayed.push(sHand.splice(idx, 1)[0]);
        });
        handlePlayCards(socket.seatIndex, actualPlayed); 
        io.to(socket.id).emit('initHand', sHand);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => { console.log(`云端服务器已启动`); });
