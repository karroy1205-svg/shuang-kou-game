const socket = io();
let myHand = [], myIdx = -1, mainS = '?', gState = 'LOBBY', isTrumpOn = false;
let localTimer = null, trickClient = [];
let amISpectator = false, amIOwner = false, myName = "";
let roomInfo = []; // 存座位信息

const dom = {
    lobby: document.getElementById('lobby-screen'),
    ident: document.getElementById('my-identity'),
    startBtn: document.getElementById('start-btn'),
    readyBtn: document.getElementById('ready-btn'),
    ownerPan: document.getElementById('owner-panel'),
    playerPan: document.getElementById('player-panel'),
    specPan: document.getElementById('spectator-panel'),
    bc: document.getElementById('sys-broadcast'),
    timer: document.getElementById('time-left'),
    pub: document.getElementById('public-cards-area'),
    btns: {
        draw: document.getElementById('draw-btn'), call: document.getElementById('call-btn'),
        over: document.getElementById('override-btn'), want: document.getElementById('want-btn'),
        take: document.getElementById('take-bottom-btn'), bury: document.getElementById('bury-btn'), play: document.getElementById('play-btn')
    }
};

function getVal(c) { return c.value === '大王' ? '大' : (c.value === '小王' ? '小' : c.value); }
function renderPub(cards) {
    dom.pub.innerHTML = '';
    cards.forEach(c => {
        let div = document.createElement('div'); div.className = 'playing-card';
        let isRed = (c.suit === '♥' || c.suit === '♦' || c.value === '大王');
        div.innerHTML = `<div class="card-corner" style="color:${isRed?'#d32f2f':'#333'}"><span>${getVal(c)}</span><span>${c.suit==='Joker'?'王':c.suit}</span></div>`;
        dom.pub.appendChild(div);
    });
}
function getW(c) {
    const sB = {'♠':3000,'♥':2000,'♣':1000,'♦':0}, pt = {'4':4,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[c.value]||0;
    if(c.value==='5') return c.suit===mainS?100000:90000+sB[c.suit];
    if(c.value==='大王') return 80000; if(c.value==='小王') return 70000;
    if(c.value==='3') return c.suit===mainS?60000:50000+sB[c.suit];
    if(c.value==='2') return c.suit===mainS?40000:30000+sB[c.suit];
    return (c.suit===mainS?20000:0) + sB[c.suit] + pt;
}

function renderHand() {
    const box = document.getElementById('card-container');
    box.innerHTML = ''; myHand.sort((a,b)=>getW(b)-getW(a));
    myHand.forEach((c, i) => {
        let div = document.createElement('div'); div.className = 'playing-card'; div.dataset.index = i;
        if(isTrumpOn && (c.suit===mainS || ['5','3','2','Joker'].includes(c.value))) div.classList.add('trump-glow');
        let isRed = (c.suit==='♥'||c.suit==='♦'||c.value==='大王');
        div.innerHTML = `<div class="card-corner" style="color:${isRed?'#d32f2f':'#333'}"><span>${getVal(c)}</span><span>${c.suit==='Joker'?'王':c.suit}</span></div>`;
        div.onclick = () => { if(!amISpectator) { div.classList.toggle('selected'); div.style.zIndex = div.classList.contains('selected')?i+100:i; } };
        box.appendChild(div);
    });
    
    if(!amISpectator) {
        let has3 = myHand.some(c=>c.value==='3'), pair3 = null, counts={};
        myHand.forEach(c=>{ if(c.value==='3'){ counts[c.suit]=(counts[c.suit]||0)+1; if(counts[c.suit]===2)pair3=c.suit; }});
        dom.btns.call.style.display = (gState==='DRAWING'&&has3&&mainS==='?')?'inline-block':'none';
        dom.btns.over.style.display = (gState==='DRAWING'&&pair3)?'inline-block':'none';
        if(pair3) dom.btns.over.dataset.suit = pair3;
    }
}

// 按钮交互
dom.readyBtn.onclick = () => { socket.emit('toggleReady'); dom.readyBtn.classList.toggle('active'); dom.readyBtn.innerText = dom.readyBtn.classList.contains('active')?"已准备":"点我准备"; };
dom.startBtn.onclick = () => socket.emit('startGame', document.getElementById('match-length').value);
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
dom.btns.play.onclick = () => {
    let sels = document.querySelectorAll('.selected'); if(sels.length===0)return;
    let ids = Array.from(sels).map(n=>parseInt(n.dataset.index)).sort((a,b)=>b-a);
    let cards = ids.map(idx => myHand[idx]); ids.forEach(idx => myHand.splice(idx,1));
    socket.emit('playCards', cards); dom.btns.play.style.display='none'; renderHand();
};

// ==========================================
// 网络通信
// ==========================================
socket.on('seatAssigned', d => {
    myIdx = d.seatIndex; myName = d.nickname; amIOwner = d.isOwner; amISpectator = false;
    dom.ident.innerText = `你是: ${myName} (座位号: ${myIdx+1})`;
    dom.ownerPan.style.display = amIOwner ? 'block' : 'none';
    dom.playerPan.style.display = (!amIOwner && !amISpectator) ? 'block' : 'none';
    dom.specPan.style.display = 'none';
});

socket.on('spectatorMode', name => {
    amISpectator = true; myName = name;
    dom.ident.innerText = `你是: ${myName} (观众)`;
    dom.ownerPan.style.display = 'none'; dom.playerPan.style.display = 'none'; dom.specPan.style.display = 'block';
});

socket.on('roomStateSync', d => {
    roomInfo = d.seats;
    document.getElementById('spec-count').innerText = d.spectatorsCount;
    if(d.state !== 'LOBBY') dom.lobby.style.display = 'none';
    else dom.lobby.style.display = 'flex';

    // 渲染大厅座位状态
    let readyCount = 0, seatedCount = 0;
    for(let i=0; i<4; i++) {
        let seatUI = document.getElementById(`seat-${i}`);
        let oppUI = document.getElementById(`opp-${['south','east','north','west'][(i - myIdx + 4) % 4]}`); // 根据相对位置推算桌面UI
        
        if (d.seats[i]) {
            seatedCount++;
            let s = d.seats[i];
            if(s.isReady || s.isOwner) readyCount++;
            
            seatUI.innerHTML = s.isOwner ? `👑 ${s.name}` : (s.isReady ? `✅ ${s.name}` : `⏳ ${s.name}`);
            seatUI.className = 'seat' + (s.isOwner ? ' owner' : '') + (s.isReady ? ' ready' : '');
            
            // 更新游戏里的桌面名字
            if(oppUI) oppUI.innerHTML = `🪑 ${s.name}<br>🎴 准备中`;
        } else {
            seatUI.innerHTML = '空座'; seatUI.className = 'seat';
        }
    }
    
    // 房主按钮权限
    if(amIOwner) {
        dom.startBtn.disabled = !(seatedCount === 4 && readyCount === 4);
        dom.startBtn.innerText = dom.startBtn.disabled ? "等待全员准备..." : "🚀 开始游戏";
    }
});

socket.on('systemMsg', m => dom.bc.innerText=m);
socket.on('startTimer', s => { clearInterval(localTimer); let l=s; dom.timer.innerText=l; localTimer=setInterval(()=>{l--;if(l>=0)dom.timer.innerText=l;else clearInterval(localTimer);},1000);});
socket.on('gameStateSync', d => {
    gState=d.state; mainS=d.mainSuit;
    document.getElementById('current-game').innerText=d.match.currentGame;
    document.getElementById('team1-wins').innerText=d.match.team1Wins;
    document.getElementById('team2-wins').innerText=d.match.team2Wins;
    document.getElementById('main-suit-icon').innerText=mainS;
    document.getElementById('score').innerText=d.score;
    renderHand();
});
socket.on('initHand', h => { myHand=h; trickClient=[]; renderHand(); });
socket.on('drawResp', c => { myHand.push(c); renderHand(); });
socket.on('showPub', c => renderPub(c));
socket.on('clearPub', () => dom.pub.innerHTML='');
socket.on('recvBottom', c => { myHand.push(...c); renderHand(); });

socket.on('turnUpd', t => { 
    if(amISpectator) return;
    dom.btns.draw.style.display = (gState==='DRAWING'&&t===myIdx)?'inline-block':'none';
    dom.btns.play.style.display = (gState==='PLAYING'&&t===myIdx)?'inline-block':'none'; 
});
socket.on('takeBottomSig', t => dom.btns.take.style.display = (!amISpectator && t===myIdx)?'inline-block':'none');
socket.on('playerPlayed', d => {
    let diff = amISpectator ? d.idx : (d.idx - myIdx + 4)%4; // 观众默认看绝对视角
    let slot = document.getElementById(['slot-south','slot-east','slot-north','slot-west'][diff]);
    slot.innerHTML = ''; d.cards.forEach(c => {
        let div = document.createElement('div'); div.className='playing-card'; div.style.transform='scale(0.8)'; div.style.marginLeft='-45px';
        let isRed = (c.suit==='♥'||c.suit==='♦'||c.value==='大王');
        div.innerHTML = `<div class="card-corner" style="color:${isRed?'#d32f2f':'#333'}"><span>${getVal(c)}</span><span>${c.suit==='Joker'?'王':c.suit}</span></div>`;
        slot.appendChild(div);
    });
    if(slot.firstChild) slot.firstChild.style.marginLeft='0';
});
socket.on('clearTable', () => { ['slot-south','slot-east','slot-north','slot-west'].forEach(id=>document.getElementById(id).innerHTML=''); });
document.getElementById('trump-toggle').onchange = (e) => { isTrumpOn=e.target.checked; renderHand(); };
