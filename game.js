const socket = io();
let myHand = [], myIdx = -1, mainS = '?', gState = 'WAITING', isTrumpOn = false;
let localTimer = null, trickClient = [];

const dom = {
    lobby: document.getElementById('lobby-screen'),
    startBtn: document.getElementById('start-match-btn'),
    bc: document.getElementById('sys-broadcast'),
    timer: document.getElementById('time-left'),
    pub: document.getElementById('public-cards-area'),
    btns: {
        draw: document.getElementById('draw-btn'),
        call: document.getElementById('call-btn'),
        over: document.getElementById('override-btn'),
        want: document.getElementById('want-btn'),
        take: document.getElementById('take-bottom-btn'),
        bury: document.getElementById('bury-btn'),
        play: document.getElementById('play-btn')
    }
};

function getValText(c) { return c.value === '大王' ? '大' : (c.value === '小王' ? '小' : c.value); }

function renderPub(cards) {
    dom.pub.innerHTML = '';
    cards.forEach(c => {
        let div = document.createElement('div'); div.className = 'playing-card';
        let isRed = (c.suit === '♥' || c.suit === '♦' || c.value === '大王');
        div.innerHTML = `<div class="card-corner" style="color:${isRed ? '#d32f2f' : '#333'}"><span>${getValText(c)}</span><span>${c.suit === 'Joker' ? '王' : c.suit}</span></div>`;
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
        let div = document.createElement('div'); div.className = 'playing-card';
        div.dataset.index = i; // ！！关键修复：绑定物理索引 ！！
        if(isTrumpOn && (c.suit===mainS || ['5','3','2','Joker'].includes(c.value))) div.classList.add('trump-glow');
        let isRed = (c.suit==='♥'||c.suit==='♦'||c.value==='大王');
        div.innerHTML = `<div class="card-corner" style="color:${isRed?'#d32f2f':'#333'}"><span>${getValText(c)}</span><span>${c.suit==='Joker'?'王':c.suit}</span></div>`;
        div.onclick = () => { div.classList.toggle('selected'); div.style.zIndex = div.classList.contains('selected')?i+100:i; };
        box.appendChild(div);
    });
    
    // 亮3按钮逻辑
    let has3 = myHand.some(c=>c.value==='3'), pair3 = null, counts={};
    myHand.forEach(c=>{ if(c.value==='3'){ counts[c.suit]=(counts[c.suit]||0)+1; if(counts[c.suit]===2)pair3=c.suit; }});
    dom.btns.call.style.display = (gState==='DRAWING'&&has3&&mainS==='?')?'inline-block':'none';
    dom.btns.over.style.display = (gState==='DRAWING'&&pair3)?'inline-block':'none';
    if(pair3) dom.btns.over.dataset.suit = pair3;
}

// 交互
dom.startBtn.onclick = () => socket.emit('startMatch', document.getElementById('match-length').value);
dom.btns.call.onclick = () => socket.emit('callTrump', myHand.find(c=>c.value==='3').suit);
dom.btns.over.onclick = () => socket.emit('overrideTrump', dom.btns.over.dataset.suit);
dom.btns.take.onclick = () => { socket.emit('takeBottomAck'); dom.btns.take.style.display='none'; dom.btns.bury.style.display='inline-block'; };
dom.btns.bury.onclick = () => {
    let sels = document.querySelectorAll('.selected'); if(sels.length!==8)return alert("选8张");
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

socket.on('showLobby', () => dom.startBtn.style.display='inline-block');
socket.on('hideLobby', () => dom.lobby.style.display='none');
socket.on('systemMsg', m => dom.bc.innerText=m);
socket.on('startTimer', s => { clearInterval(localTimer); let l=s; dom.timer.innerText=l; localTimer=setInterval(()=>{l--;if(l>=0)dom.timer.innerText=l;else clearInterval(localTimer);},1000);});
socket.on('stateSync', d => {
    gState=d.state; mainS=d.mainSuit;
    document.getElementById('current-game').innerText=d.match.currentGame;
    document.getElementById('team1-wins').innerText=d.match.team1Wins;
    document.getElementById('team2-wins').innerText=d.match.team2Wins;
    document.getElementById('main-suit-icon').innerText=mainS;
    document.getElementById('score').innerText=d.score;
    document.getElementById('on-stage-players').innerText = d.onStage.map(i=>`玩家${i+1}`).join(',');
    renderHand();
});
socket.on('initHand', h => { myHand=h; trickClient=[]; renderHand(); });
socket.on('drawResp', c => { myHand.push(c); renderHand(); });
socket.on('showPub', c => renderPub(c));
socket.on('clearPub', () => dom.pub.innerHTML='');
socket.on('recvBottom', c => { myHand.push(...c); renderHand(); });
socket.on('turnUpd', t => { dom.btns.play.style.display = (gState==='PLAYING'&&t===myIdx)?'inline-block':'none'; });
socket.on('takeBottomSig', t => dom.btns.take.style.display = (t===myIdx)?'inline-block':'none');
socket.on('playerPlayed', d => {
    let diff = (d.idx - myIdx + 4)%4;
    let slot = document.getElementById(['slot-south','slot-east','slot-north','slot-west'][diff]);
    slot.innerHTML = ''; d.cards.forEach(c => {
        let div = document.createElement('div'); div.className='playing-card'; div.style.transform='scale(0.8)'; div.style.marginLeft='-45px';
        let isRed = (c.suit==='♥'||c.suit==='♦'||c.value==='大王');
        div.innerHTML = `<div class="card-corner" style="color:${isRed?'#d32f2f':'#333'}"><span>${getValText(c)}</span><span>${c.suit==='Joker'?'王':c.suit}</span></div>`;
        slot.appendChild(div);
    });
    if(slot.firstChild) slot.firstChild.style.marginLeft='0';
});
socket.on('clearTable', () => { ['slot-south','slot-east','slot-north','slot-west'].forEach(id=>document.getElementById(id).innerHTML=''); });
document.getElementById('trump-toggle').onchange = (e) => { isTrumpOn=e.target.checked; renderHand(); };