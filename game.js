const socket = io();
let myHand = [], myIdx = -1, mainS = '?', gState = 'LOBBY', isTrumpOn = false, isFirstG = false;
let localTimer = null, trickClient = [];
let amISpectator = false, amIOwner = false, myName = "";
let roomInfo = []; 
let currentTurnIdx = -1;

const dom = {
    lobby: document.getElementById('lobby-screen'), ident: document.getElementById('my-identity'),
    startBtn: document.getElementById('start-btn'), readyBtn: document.getElementById('ready-btn'),
    ownerPan: document.getElementById('owner-panel'), playerPan: document.getElementById('player-panel'), specPan: document.getElementById('spectator-panel'),
    bc: document.getElementById('sys-broadcast'), hlBtn: document.getElementById('highlight-toggle-btn'),
    deckArea: document.getElementById('deck-area'), pubArea: document.getElementById('public-cards-area'),
    targetCardUI: document.getElementById('target-card-ui'), cardsRemain: document.getElementById('cards-remain'),
    pileL: document.getElementById('pile-left'), pileR: document.getElementById('pile-right'),
    btns: { draw: document.getElementById('draw-btn'), call: document.getElementById('call-btn'), over: document.getElementById('override-btn'), want: document.getElementById('want-btn'), take: document.getElementById('take-bottom-btn'), bury: document.getElementById('bury-btn'), play: document.getElementById('play-btn') }
};

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

function renderHand() {
    const box = document.getElementById('card-container'); box.innerHTML = ''; 
    myHand.sort((a,b)=>getW(b)-getW(a));
    myHand.forEach((c, i) => {
        let div = document.createElement('div'); div.className = 'playing-card'; div.dataset.index = i;
        if(isTrumpOn && getEffSuit(c)==='trump') div.classList.add('trump-glow');
        let isRed = (c.suit==='♥'||c.suit==='♦'||c.value==='大王');
        div.innerHTML = `<div class="card-corner" style="color:${isRed?'#d32f2f':'#333'}"><span>${getVal(c)}</span><span>${c.suit==='Joker'?'王':c.suit}</span></div>`;
        div.onclick = () => { if(!amISpectator) { div.classList.toggle('selected'); div.style.zIndex = div.classList.contains('selected')?i+100:i; } };
        box.appendChild(div);
    });
    
    if(!amISpectator && !isFirstG) {
        let has3 = myHand.some(c=>c.value==='3'), pair3 = null, counts={};
        myHand.forEach(c=>{ if(c.value==='3'){ counts[c.suit]=(counts[c.suit]||0)+1; if(counts[c.suit]===2)pair3=c.suit; }});
        dom.btns.call.style.display = (gState==='DRAWING'&&has3&&mainS==='?')?'inline-block':'none';
        dom.btns.over.style.display = (gState==='DRAWING'&&pair3)?'inline-block':'none';
        if(pair3) dom.btns.over.dataset.suit = pair3;
    } else {
        dom.btns.call.style.display = 'none'; dom.btns.over.style.display = 'none';
    }
}

// ==========================================
// 按钮交互与防作弊校验
// ==========================================
dom.hlBtn.onclick = () => { isTrumpOn = !isTrumpOn; dom.hlBtn.innerText = isTrumpOn?"取消高亮":"✨ 开启主牌高亮"; renderHand(); };
dom.readyBtn.onclick = () => { socket.emit('toggleReady'); dom.readyBtn.classList.toggle('active'); dom.readyBtn.innerText = dom.readyBtn.classList.contains('active')?"已准备":"点我准备"; };
dom.startBtn.onclick = () => { socket.emit('startGame', document.getElementById('match-length').value); };
dom.btns.draw.onclick = () => { socket.emit('reqDraw'); dom.btns.draw.style.display='none'; };
dom.btns.call.onclick = () => { socket.emit('callTrump', myHand.find(c=>c.value==='3').suit); dom.btns.call.style.display='none';};
dom.btns.over.onclick = () => { socket.emit('overrideTrump', dom.btns.over.dataset.suit); dom.btns.over.style.display='none';};
dom.btns.want.onclick = () => { socket.emit('toggleWant', true); dom.btns.want.style.display='none'; };
dom.btns.take.onclick = () => { socket.emit('takeBottomAck'); dom.btns.take.style.display='none'; dom.btns.bury.style.display='inline-block'; };
dom.btns.bury.onclick = () => {
    let sels = document.querySelectorAll('.selected'); if(sels.length!==8)return alert("请选8张");
    let ids = Array.from(sels).map(n=>parseInt(n.dataset.index)).sort((a,b)=>b-a);
    let cards = ids.map(idx => myHand[idx]); ids.forEach(idx => myHand.splice(idx,1));
    socket.emit('buryCards', cards); dom.btns.bury.style.display='none'; renderHand();
};

// ！！核心：出牌合法性极度严格校验！！
dom.btns.play.onclick = () => {
    let sels = document.querySelectorAll('.selected'); if(sels.length===0)return;
    let ids = Array.from(sels).map(n=>parseInt(n.dataset.index)).sort((a,b)=>b-a);
    let cards = ids.map(idx => myHand[idx]); 
    
    // 规则 1：张数限制 (单次仅允许1张或同花色对子)
    if(cards.length > 2) return alert("单次仅允许出单张或对子！");
    if(cards.length === 2) {
        if(cards[0].suit !== cards[1].suit || cards[0].value !== cards[1].value) return alert("两张牌必须是绝对的同花色对子！");
    }

    // 规则 2：强制跟牌
    if(trickClient.length > 0) {
        let leadCards = trickClient[0].cards;
        if(cards.length !== leadCards.length) return alert(`必须出 ${leadCards.length} 张！`);
        let leadSuit = getEffSuit(leadCards[0]);
        let playSuit = getEffSuit(cards[0]);
        if(playSuit !== leadSuit) {
            let hasLead = myHand.some(c => getEffSuit(c) === leadSuit);
            if(hasLead) return alert(`非法操作！你手里还有【${leadSuit==='trump'?'主牌':leadSuit}】，必须跟出！`);
        }
    }

    ids.forEach(idx => myHand.splice(idx,1));
    socket.emit('playCards', cards); dom.btns.play.style.display='none'; renderHand();
};

// ==========================================
// 网络数据与动态头像读秒
// ==========================================
socket.on('seatAssigned', d => {
    myIdx = d.seatIndex; myName = d.nickname; amIOwner = d.isOwner; amISpectator = false;
    dom.ident.innerText = `你是: ${myName} (座位号: ${myIdx+1})`;
    dom.ownerPan.style.display = amIOwner ? 'block' : 'none'; dom.playerPan.style.display = (!amIOwner) ? 'block' : 'none'; dom.specPan.style.display = 'none';
});
socket.on('spectatorMode', name => {
    amISpectator = true; myName = name; dom.ident.innerText = `你是: ${myName} (观众)`;
    dom.ownerPan.style.display = 'none'; dom.playerPan.style.display = 'none'; dom.specPan.style.display = 'block';
});

function updateAvatarUI() {
    for(let i=0; i<4; i++) {
        let diff = amISpectator ? i : (i - myIdx + 4) % 4;
        let pId = ['player-south','player-east','player-north','player-west'][diff];
        let pUI = document.getElementById(pId);
        if(!pUI) continue;
        
        // 更新名字
        let sInfo = roomInfo[i];
        if(sInfo && pId !== 'player-south') {
            pUI.querySelector('.opp-info').innerHTML = `${sInfo.name}<br>🎴 在线`;
        }

        // 呼吸灯特效与读秒分配
        if(i === currentTurnIdx && (gState === 'PLAYING' || gState === 'DRAWING' || gState === 'BURYING')) {
            pUI.classList.add('active-turn');
        } else {
            pUI.classList.remove('active-turn');
            pUI.querySelector('.timer-badge').innerText = '0';
        }
    }
}

socket.on('roomStateSync', d => { roomInfo = d.seats; document.getElementById('spec-count').innerText = d.spectatorsCount; updateAvatarUI();
    if(amIOwner) {
        let seatedCount = 0, readyCount = 0;
        d.seats.forEach(s => { if(s){ seatedCount++; if(s.isReady || s.isOwner) readyCount++; }});
        dom.startBtn.disabled = !(seatedCount === 4 && readyCount === 4);
        dom.startBtn.innerText = dom.startBtn.disabled ? "等待全员准备" : "🚀 开始游戏";
    }
});

socket.on('hideLobby', () => { dom.lobby.style.display = 'none'; });
socket.on('showLobbyFallback', () => { dom.lobby.style.display = 'flex'; });

socket.on('gameStateSync', d => {
    gState=d.state; mainS=d.mainSuit; isFirstG=d.isFirstGame;
    document.getElementById('current-game').innerText=d.match.currentGame;
    document.getElementById('team1-wins').innerText=d.match.team1Wins;
    document.getElementById('team2-wins').innerText=d.match.team2Wins;
    document.getElementById('main-suit-icon').innerText=mainS;
    document.getElementById('score').innerText=d.score;
    let stageStr = d.onStage.length > 0 ? d.onStage.map(i=>roomInfo[i]?roomInfo[i].name:"?").join(', ') : "迷雾中(等待抓天命牌)";
    document.getElementById('on-stage-players').innerText = stageStr;
    renderHand();
});

socket.on('deckSync', d => {
    dom.deckArea.style.display = d.remain > 0 ? 'flex' : 'none';
    dom.cardsRemain.innerText = d.remain;
    let shadowVal = Math.ceil(d.remain / 20); 
    dom.pileL.style.boxShadow = `${shadowVal}px ${shadowVal}px 0 #95a5a6`; dom.pileR.style.boxShadow = `${shadowVal}px ${shadowVal}px 0 #95a5a6`;
    if (d.target) {
        dom.targetCardUI.style.display = 'flex'; let isRed = (d.target.suit==='♥'||d.target.suit==='♦');
        dom.targetCardUI.innerHTML = `<span style="color:${isRed?'#d32f2f':'#333'}">${getVal(d.target)}<br>${d.target.suit}</span>`;
    } else { dom.targetCardUI.style.display = 'none'; }
});

socket.on('systemMsg', m => dom.bc.innerText=m);

// ！！全局计时器分配引擎 ！！
socket.on('startTimer', s => { 
    clearInterval(localTimer); let l=s; 
    let activeBadge = document.querySelector('.active-turn .timer-badge');
    if(activeBadge) activeBadge.innerText = l;
    localTimer=setInterval(()=>{
        l--; 
        let badge = document.querySelector('.active-turn .timer-badge');
        if(l>=0 && badge) badge.innerText=l;
        else clearInterval(localTimer);
    },1000);
});

socket.on('initHand', h => { myHand=h; trickClient=[]; renderHand(); });
socket.on('drawResp', c => { myHand.push(c); renderHand(); });
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
socket.on('recvBottom', c => { myHand.push(...c); renderHand(); });

socket.on('turnUpd', t => { 
    currentTurnIdx = t; updateAvatarUI();
    if(amISpectator) return;
    dom.btns.draw.style.display = (gState==='DRAWING'&&t===myIdx)?'inline-block':'none';
    dom.btns.play.style.display = (gState==='PLAYING'&&t===myIdx)?'inline-block':'none'; 
});

socket.on('takeBottomSig', t => {
    currentTurnIdx = t; updateAvatarUI();
    dom.btns.take.style.display = (!amISpectator && t===myIdx)?'inline-block':'none';
});

socket.on('playerPlayed', d => {
    if(trickClient.length===4) trickClient=[]; // 新一轮清理本地桌
    trickClient.push(d);
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
