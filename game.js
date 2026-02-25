const socket = io();
let myHand = [], myIdx = -1, mainS = '?', gState = 'LOBBY', isTrumpOn = false, isFirstG = false;
let localTimer = null, trickClient = [];
let amISpectator = false, amIOwner = false, myName = "";
let roomInfo = [], onStagePlayers = []; 
let currentTurnIdx = -1;

const dom = {
    lobby: document.getElementById('lobby-screen'), 
    settlement: document.getElementById('settlement-screen'),
    ident: document.getElementById('my-identity'),
    startBtn: document.getElementById('start-btn'), readyBtn: document.getElementById('ready-btn'),
    ownerPan: document.getElementById('owner-panel'), playerPan: document.getElementById('player-panel'), specPan: document.getElementById('spectator-panel'),
    hlBtn: document.getElementById('highlight-toggle-btn'), chatList: document.getElementById('chat-messages'), chatWin: document.getElementById('chat-window'), chatHead: document.getElementById('chat-header'),
    deckArea: document.getElementById('deck-area'), pubArea: document.getElementById('public-cards-area'), targetCardUI: document.getElementById('target-card-ui'), cardsRemain: document.getElementById('cards-remain'), pileL: document.getElementById('pile-left'), pileR: document.getElementById('pile-right'),
    btns: { 
        draw: document.getElementById('draw-btn'), call: document.getElementById('call-btn'), over: document.getElementById('override-btn'), 
        want: document.getElementById('want-btn'), take: document.getElementById('take-bottom-btn'), bury: document.getElementById('bury-btn'), 
        payT: document.getElementById('pay-tribute-btn'), retT: document.getElementById('return-tribute-btn'), play: document.getElementById('play-btn') 
    }
};

window.kickPlayer = (id) => { if(confirm("确定要踢出该玩家吗？")) socket.emit('kickPlayer', id); };
window.transferOwner = (id) => { if(confirm("确定要移交房主吗？")) socket.emit('transferOwner', id); };

dom.chatHead.onclick = () => dom.chatWin.classList.toggle('open');
function addLog(msg) { 
    let li = document.createElement('li'); li.innerText = msg; 
    dom.chatList.appendChild(li); dom.chatList.scrollTop = dom.chatList.scrollHeight; 
}

function getVal(c) { return c.value === '大王' ? '大' : (c.value === '小王' ? '小' : c.value); }
function getEffSuit(c) { return (c.suit==='Joker'||['5','3','2'].includes(c.value)||c.suit===mainS)?'trump':c.suit; }

function getW(c) {
    const sB = {'♠':3000,'♥':2000,'♣':1000,'♦':0}, pt = {'4':4,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[c.value]||0;
    if(c.value==='5') return c.suit===mainS?100000:90000+sB[c.suit];
    if(c.value==='大王') return 80000; if(c.value==='小王') return 70000;
    if(c.value==='3') return c.suit===mainS?60000:50000+sB[c.suit];
    if(c.value==='2') return c.suit===mainS?40000:30000+sB[c.suit];
    return (c.suit===mainS?20000:0) + sB[c.suit] + pt;
}

function updateUI() {
    let isMe = (currentTurnIdx === myIdx) && !amISpectator;
    // 重置所有操作按钮
    Object.values(dom.btns).forEach(btn => btn.style.display = 'none');

    if (gState === 'DRAWING' || gState === 'POST_DRAW') {
        if(gState === 'DRAWING' && isMe) dom.btns.draw.style.display = 'inline-block';
        if(!amISpectator && !isFirstG) {
            let has3 = myHand.some(c=>c.value==='3'), pair3 = null, counts={};
            myHand.forEach(c=>{ if(c.value==='3'){ counts[c.suit]=(counts[c.suit]||0)+1; if(counts[c.suit]===2)pair3=c.suit; }});
            if(has3 && mainS==='?') dom.btns.call.style.display = 'inline-block';
            if(pair3) { dom.btns.over.style.display = 'inline-block'; dom.btns.over.dataset.suit = pair3; }
        }
    }
    
    if (gState === 'NEGOTIATING' && !amISpectator && onStagePlayers.includes(myIdx)) dom.btns.want.style.display = 'inline-block';
    if (gState === 'BURYING_TAKE' && isMe) dom.btns.take.style.display = 'inline-block';
    if (gState === 'BURYING_ACTION' && isMe) dom.btns.bury.style.display = 'inline-block';
    if (gState === 'PLAYING' && isMe) dom.btns.play.style.display = 'inline-block';
}

function renderHand() {
    const box = document.getElementById('card-container'); box.innerHTML = ''; 
    myHand.sort((a,b)=>getW(b)-getW(a));
    myHand.forEach((c, i) => {
        let div = document.createElement('div'); div.className = 'playing-card'; div.dataset.index = i;
        if(isTrumpOn && getEffSuit(c)==='trump') div.classList.add('trump-glow');
        let isRed = (c.suit==='♥'||c.suit==='♦'||c.value==='大王');
        div.innerHTML = `<div class="card-corner" style="color:${isRed?'#d32f2f':'#333'}"><span>${getVal(c)}</span><span>${c.suit==='Joker'?'王':c.suit}</span></div>`;
        
        div.onclick = () => { 
            if(!amISpectator && ['BURYING_ACTION', 'PLAYING', 'TRIBUTE_PAY', 'TRIBUTE_RETURN'].includes(gState)) { 
                div.classList.toggle('selected'); 
            } 
        };
        box.appendChild(div);
    });
    updateUI();
}

dom.hlBtn.onclick = () => { isTrumpOn = !isTrumpOn; dom.hlBtn.innerText = isTrumpOn?"取消高亮":"✨ 主牌高亮"; renderHand(); };
dom.readyBtn.onclick = () => { socket.emit('toggleReady'); dom.readyBtn.classList.toggle('active'); dom.readyBtn.innerText = dom.readyBtn.classList.contains('active')?"已准备":"点我准备"; };
dom.startBtn.onclick = () => { socket.emit('startGame', { len: document.getElementById('match-length').value, reset: document.getElementById('reset-match-chk').checked }); };

// 结算系统确认
document.getElementById('confirm-settlement-btn').onclick = () => {
    socket.emit('ackSettlement');
    document.getElementById('confirm-settlement-btn').style.display = 'none';
    document.getElementById('settlement-wait-msg').style.display = 'block';
};

dom.btns.draw.onclick = () => { socket.emit('reqDraw'); };
dom.btns.call.onclick = () => { socket.emit('callTrump', myHand.find(c=>c.value==='3').suit); };
dom.btns.over.onclick = () => { socket.emit('overrideTrump', dom.btns.over.dataset.suit); };
dom.btns.want.onclick = () => { socket.emit('toggleWant'); };
dom.btns.take.onclick = () => { socket.emit('takeBottomAck'); };

// 进贡交互
dom.btns.payT.onclick = () => {
    let sels = document.querySelectorAll('.selected'); if(sels.length!==1)return alert("请选1张最大的主牌");
    let card = myHand[parseInt(sels[0].dataset.index)];
    socket.emit('payTribute', card); dom.btns.payT.style.display='none';
};
dom.btns.retT.onclick = () => {
    let sels = document.querySelectorAll('.selected'); if(sels.length!==1)return alert("请选1张最小的牌");
    let card = myHand[parseInt(sels[0].dataset.index)];
    socket.emit('returnTribute', card); dom.btns.retT.style.display='none';
};

dom.btns.bury.onclick = () => {
    let sels = document.querySelectorAll('.selected'); if(sels.length!==8)return alert("请选8张");
    let ids = Array.from(sels).map(n=>parseInt(n.dataset.index)).sort((a,b)=>b-a);
    let buriedCards = ids.map(idx => myHand[idx]); 
    ids.forEach(idx => myHand.splice(idx,1));
    socket.emit('buryCards', { buried: buriedCards, leftoverHand: myHand }); 
    dom.btns.bury.style.display='none'; renderHand();
};

dom.btns.play.onclick = () => {
    let sels = document.querySelectorAll('.selected'); if(sels.length===0)return;
    let ids = Array.from(sels).map(n=>parseInt(n.dataset.index)).sort((a,b)=>b-a);
    let cards = ids.map(idx => myHand[idx]); 
    
    if(trickClient.length === 0) {
        if(cards.length > 2) return alert("首发出牌单次仅允许单张或对子！");
        if(cards.length === 2 && (cards[0].value !== cards[1].value || cards[0].suit !== cards[1].suit)) return alert("首发两张牌必须是绝对同花色对子！");
    } else {
        let leadCards = trickClient[0].cards;
        if(cards.length !== leadCards.length) return alert(`必须出 ${leadCards.length} 张！`);
        let leadSuit = getEffSuit(leadCards[0]);
        
        if (leadCards.length === 1) {
            let playSuit = getEffSuit(cards[0]);
            if(playSuit !== leadSuit && myHand.some(c => getEffSuit(c) === leadSuit)) return alert(`手里还有【${leadSuit==='trump'?'主牌':leadSuit}】，必须单出！`);
        } else if (leadCards.length === 2) {
            let isPlayPair = cards[0].value === cards[1].value && cards[0].suit === cards[1].suit;
            let playSuit = isPlayPair ? getEffSuit(cards[0]) : null;
            let leadSuitHand = myHand.filter(c => getEffSuit(c) === leadSuit);
            let hasLeadPair = false;
            for(let i=0; i<leadSuitHand.length-1; i++){ if(leadSuitHand[i].value === leadSuitHand[i+1].value && leadSuitHand[i].suit === leadSuitHand[i+1].suit) hasLeadPair = true; }
            
            if (hasLeadPair) {
                if (!isPlayPair || playSuit !== leadSuit) return alert(`手里有【${leadSuit==='trump'?'主牌':leadSuit}对子】，必须跟对！`);
            } else {
                let playedLeadCount = cards.filter(c => getEffSuit(c) === leadSuit).length;
                if (leadSuitHand.length >= 2 && playedLeadCount < 2) return alert(`必须尽量出2张【${leadSuit==='trump'?'主牌':leadSuit}】！`);
                if (leadSuitHand.length === 1 && playedLeadCount < 1) return alert(`必须出1张【${leadSuit==='trump'?'主牌':leadSuit}】！`);
            }
        }
    }

    ids.forEach(idx => myHand.splice(idx,1));
    socket.emit('playCards', { played: cards, leftoverHand: myHand });
    dom.btns.play.style.display='none'; renderHand();
};

// 收发网络事件
socket.on('wantStatusSync', isWanting => { dom.btns.want.innerText = isWanting ? "取消要牌" : "我要底牌"; dom.btns.want.style.backgroundColor = isWanting ? "#e74c3c" : "#2ecc71"; });

socket.on('seatAssigned', d => {
    myIdx = d.seatIndex; myName = d.nickname; amIOwner = d.isOwner; amISpectator = false;
    dom.ident.innerText = `你是: ${myName}`;
    dom.ownerPan.style.display = amIOwner ? 'block' : 'none'; dom.playerPan.style.display = (!amIOwner) ? 'block' : 'none'; dom.specPan.style.display = 'none';
});

socket.on('ownerChanged', isOwner => { amIOwner = isOwner; dom.ownerPan.style.display = amIOwner ? 'block' : 'none'; dom.playerPan.style.display = (!amIOwner) ? 'block' : 'none'; });
socket.on('spectatorMode', name => { amISpectator = true; myName = name; dom.ident.innerText = `你是: ${myName} (观众)`; dom.ownerPan.style.display = 'none'; dom.playerPan.style.display = 'none'; dom.specPan.style.display = 'block'; });

function updateAvatarUI() {
    for(let i=0; i<4; i++) {
        let diff = amISpectator ? i : (i - myIdx + 4) % 4;
        let pId = ['player-south','player-east','player-north','player-west'][diff];
        let pUI = document.getElementById(pId);
        if(!pUI) continue;
        
        let sInfo = roomInfo[i];
        if(sInfo) {
            let nText = pId === 'player-south' ? `自己 (${sInfo.name})` : sInfo.name;
            if(sInfo.isOffline) nText += " (托管中)";
            pUI.querySelector('.name').innerText = nText; pUI.style.opacity = sInfo.isOffline ? '0.5' : '1';
        }
        
        if(i === currentTurnIdx && !sInfo?.isOffline && ['PLAYING', 'DRAWING', 'BURYING_TAKE', 'BURYING_ACTION'].includes(gState)) pUI.classList.add('active-turn');
        else { pUI.classList.remove('active-turn'); pUI.querySelector('.timer-badge').innerText = '0'; }
    }
}

socket.on('roomStateSync', d => { 
    roomInfo = d.seats; document.getElementById('spec-count').innerText = d.spectatorsCount; 
    for(let i=0; i<4; i++) {
        let seatUI = document.getElementById(`seat-${i}`);
        if (d.seats[i]) {
            let s = d.seats[i];
            let innerHtml = s.isOwner ? `👑 ${s.name}` : (s.isReady ? `✅ ${s.name}` : `⏳ ${s.name}`);
            if(s.isOffline) innerHtml += ` <span style="color:#e74c3c;">[掉线]</span>`;
            if (amIOwner && s.id !== socket.id) innerHtml += `<div style="margin-top: 8px;"><button class="action-btn-small btn-kick" onclick="window.kickPlayer('${s.id}')">踢出</button><button class="action-btn-small btn-transfer" onclick="window.transferOwner('${s.id}')">移交</button></div>`;
            seatUI.innerHTML = innerHtml; seatUI.className = 'seat' + (s.isOwner ? ' owner' : '') + (s.isReady ? ' ready' : '');
        } else { seatUI.innerHTML = '空座'; seatUI.className = 'seat'; }
    }
    updateAvatarUI();
    if(amIOwner) {
        let seatedCount = 0, readyCount = 0;
        d.seats.forEach(s => { if(s){ seatedCount++; if(s.isReady || s.isOwner || s.isOffline) readyCount++; }});
        dom.startBtn.disabled = !(seatedCount === 4 && readyCount === 4); dom.startBtn.innerText = dom.startBtn.disabled ? "等待全员准备" : "🚀 开始游戏";
    }
});

socket.on('hideLobby', () => { dom.lobby.style.display = 'none'; });
socket.on('showLobbyFallback', () => { dom.lobby.style.display = 'flex'; dom.readyBtn.classList.remove('active'); dom.readyBtn.innerText="点我准备"; });

// 结算窗开关
socket.on('showSettlement', html => {
    dom.settlement.style.display = 'flex';
    document.getElementById('settlement-details').innerHTML = html;
    document.getElementById('confirm-settlement-btn').style.display = 'inline-block';
    document.getElementById('settlement-wait-msg').style.display = 'none';
});
socket.on('hideSettlement', () => { dom.settlement.style.display = 'none'; });

// 进贡UI激活
socket.on('startTributePhase', d => {
    if (d.phase === 'PAY' && d.payers.includes(myIdx) && !amISpectator) dom.btns.payT.style.display = 'inline-block';
    if (d.phase === 'RETURN' && d.receivers.includes(myIdx) && !amISpectator) dom.btns.retT.style.display = 'inline-block';
});

socket.on('gameStateSync', d => {
    gState=d.state; mainS=d.mainSuit; isFirstG=d.isFirstGame; onStagePlayers=d.onStage;
    document.getElementById('current-game').innerText=d.match.currentGame;
    document.getElementById('team1-wins').innerText=d.match.team1Wins;
    document.getElementById('team2-wins').innerText=d.match.team2Wins;
    document.getElementById('main-suit-icon').innerText=mainS; document.getElementById('score').innerText=d.score;
    document.getElementById('on-stage-players').innerText = d.onStage.length > 0 ? d.onStage.map(i=>roomInfo[i]?roomInfo[i].name:"?").join(', ') : "迷雾中";
    
    if (!['LOBBY', 'SETTLEMENT'].includes(gState)) dom.lobby.style.display = 'none';
    if (d.cardCounts) {
        for(let i=0; i<4; i++) {
            let diff = amISpectator ? i : (i - myIdx + 4) % 4;
            let pId = ['player-south','player-east','player-north','player-west'][diff];
            if(pId !== 'player-south') { let pUI = document.getElementById(pId); if(pUI) pUI.querySelector('.card-count').innerText = d.cardCounts[i]; }
        }
    }
    renderHand(); updateAvatarUI();
});

socket.on('deckSync', d => {
    dom.deckArea.style.display = d.remain > 0 ? 'flex' : 'none'; dom.cardsRemain.innerText = d.remain;
    let shadowVal = Math.ceil(d.remain / 20); 
    dom.pileL.style.boxShadow = `${shadowVal}px ${shadowVal}px 0 #95a5a6`; dom.pileR.style.boxShadow = `${shadowVal}px ${shadowVal}px 0 #95a5a6`;
    if (d.target) { dom.targetCardUI.style.display = 'flex'; let isRed = (d.target.suit==='♥'||d.target.suit==='♦'); dom.targetCardUI.innerHTML = `<span style="color:${isRed?'#d32f2f':'#333'}">${getVal(d.target)}<br>${d.target.suit}</span>`; } else dom.targetCardUI.style.display = 'none';
});

socket.on('systemMsg', m => addLog(m));
socket.on('startTimer', s => { clearInterval(localTimer); let l=s; let activeBadge = document.querySelector('.active-turn .timer-badge'); if(activeBadge) activeBadge.innerText = l; localTimer=setInterval(()=>{ l--; let badge = document.querySelector('.active-turn .timer-badge'); if(l>=0 && badge) badge.innerText=l; else clearInterval(localTimer); },1000); });

socket.on('initHand', h => { myHand=h; trickClient=[]; renderHand(); });
socket.on('drawResp', c => { myHand.push(c); renderHand(); });
socket.on('recvBottom', c => { myHand.push(...c); renderHand(); });

socket.on('showPub', c => {
    dom.pubArea.innerHTML = '';
    c.forEach(card => {
        let div = document.createElement('div'); div.className = 'playing-card';
        let isRed = (card.suit==='♥'||card.suit==='♦'||card.value==='大王');
        div.innerHTML = `<div class="card-corner" style="color:${isRed?'#d32f2f':'#333'}"><span>${getVal(card)}</span><span>${card.suit==='Joker'?'王':card.suit}</span></div>`;
        dom.pubArea.appendChild(div);
    });
});
socket.on('clearPub', () => dom.pubArea.innerHTML='');

socket.on('turnUpd', t => { currentTurnIdx = t; updateAvatarUI(); updateUI(); });
socket.on('takeBottomSig', t => { currentTurnIdx = t; updateAvatarUI(); updateUI(); });

socket.on('playerPlayed', d => {
    if(trickClient.length===4) trickClient=[]; trickClient.push(d);
    let diff = amISpectator ? d.idx : (d.idx - myIdx + 4)%4; 
    let slot = document.getElementById(['slot-south','slot-east','slot-north','slot-west'][diff]);
    slot.innerHTML = ''; d.cards.forEach(c => {
        let div = document.createElement('div'); div.className='playing-card'; 
        let isRed = (c.suit==='♥'||c.suit==='♦'||c.value==='大王');
        div.innerHTML = `<div class="card-corner" style="color:${isRed?'#d32f2f':'#333'}"><span>${getVal(c)}</span><span>${c.suit==='Joker'?'王':c.suit}</span></div>`;
        slot.appendChild(div);
    });
});
socket.on('clearTable', () => { trickClient=[]; ['slot-south','slot-east','slot-north','slot-west'].forEach(id=>document.getElementById(id).innerHTML=''); });
