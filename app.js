let allRuns=[],allMaps=[],activeMap=null,playerStats={},globalLeaderboard=[],mapShowCount=[],comparePlayers=[],previousGlobalLeaderboard=[];
const THEMES={blue:{accent:'#4b7fff',accentL:'#6b9fff',glow:'rgba(75,127,255,.15)'},yellow:{accent:'#f0c040',accentL:'#f5d060',glow:'rgba(240,192,64,.15)'},green:{accent:'#3dd68c',accentL:'#5de6a0',glow:'rgba(61,214,140,.15)'},purple:{accent:'#a855f7',accentL:'#c084fc',glow:'rgba(168,85,247,.15)'},red:{accent:'#ef4444',accentL:'#f87171',glow:'rgba(239,68,68,.15)'},orange:{accent:'#f97316',accentL:'#fb923c',glow:'rgba(249,115,22,.15)'},pink:{accent:'#ec4899',accentL:'#f472b6',glow:'rgba(236,72,153,.15)'},cyan:{accent:'#06b6d4',accentL:'#22d3ee',glow:'rgba(6,182,212,.15)'},lime:{accent:'#84cc16',accentL:'#a3e635',glow:'rgba(132,204,22,.15)'},white:{accent:'#e4e4e7',accentL:'#f4f4f5',glow:'rgba(228,228,231,.10)'}};
const RANKS=[{name:'Champion',min:100,icon:'👑',color:'#f0c060'},{name:'Diamond',min:50,icon:'💎',color:'#b9f2ff'},{name:'Gold',min:25,icon:'🥇',color:'#f0c060'},{name:'Silver',min:10,icon:'🥈',color:'#a0b0c4'},{name:'Bronze',min:3,icon:'🥉',color:'#c08840'},{name:'Unranked',min:0,icon:'⬜',color:'#555568'}];
function getRank(pts){return RANKS.find(r=>pts>=r.min)||RANKS[RANKS.length-1]}
function applyTheme(n){const t=THEMES[n];if(!t)return;document.documentElement.style.setProperty('--accent',t.accent);document.documentElement.style.setProperty('--accentL',t.accentL);document.documentElement.style.setProperty('--accentGlow',t.glow);localStorage.setItem('theme',n);renderColorGrid(n)}
function renderColorGrid(a){document.getElementById('color-grid').innerHTML=Object.entries(THEMES).map(([n,t])=>'<div class="color-swatch'+(n===a?' active':'')+'" style="background:'+t.accent+'" onclick="applyTheme(\''+n+'\')"></div>').join('')}

function animateRanking(){
  const leaderboard = document.getElementById("global-list");
  const rows = leaderboard.getElementsByTagName("tr");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rank = row.getElementsByTagName("td")[0].textContent;
    const player = row.getElementsByTagName("td")[1].textContent;
    const points = row.getElementsByTagName("td")[2].textContent;
    const prevRank = previousGlobalLeaderboard.find(p => p.player === player);
    if (prevRank && prevRank.rank !== rank) {
      row.classList.add("animate");
      setTimeout(() => row.classList.remove("animate"), 2000);
    }
  }
}
function createConfetti(){}
function toggleSettings(){document.getElementById('settings-panel').classList.toggle('active')}
function toggleLightMode(){document.documentElement.classList.toggle('light');const on=document.documentElement.classList.contains('light');document.getElementById('theme-toggle').classList.toggle('on',on);localStorage.setItem('lightMode',on?'1':'0')}
function formatTime(s){const m=Math.floor(s/60);return m+"m"+String(s%60).padStart(2,"0")+"s"}
function formatDate(iso){return new Date(iso).toLocaleDateString("fr-FR",{day:"2-digit",month:"2-digit"})}
function getRunUrl(r){return r.url||("https://openfront.io/game/"+r.id)}
function esc(s){return s.replace(/'/g,"\\'")}
function playSound(){}
function notifyNewRecord(msg){if(Notification.permission==='granted'){new Notification('OpenFront SpeedRun',{body:msg,icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><text y="32" font-size="32">🏆</text></svg>'});playSound()}}
function requestNotifs(){if('Notification' in window)Notification.requestPermission()}

/* ====== AUTH LOGIC ====== */
let currentUser = null;
let playerClientIds = new Set(); // IDs OpenFront liés au compte connecté
let playerAliases = new Set(); // Anciens pseudonymes trouvés via l'API OpenFront

// Écouter les changements d'état d'auth au chargement
import { auth, db, doc, getDoc, setDoc, onAuthStateChanged } from "./auth.js";

onAuthStateChanged(auth, async (user) => {
  if (user) {
    // Vérifier si le profil existe déjà dans Firestore
    const userDoc = await getDoc(doc(db, "users", user.uid));
    
    if (userDoc.exists()) {
      const userData = userDoc.data();
      currentUser = {
        name: userData.username,
        publicId: userData.publicId,
        avatar: user.photoURL,
        uid: user.uid
      };
      
      // Récupérer les Client IDs et les pseudos historiques depuis l'API OpenFront
      await fetchPlayerClientIds(userData.publicId);
      
      updateAuthUI(currentUser);
      processData(); // Re-traiter les données pour appliquer la fusion
      renderAll();
      console.log("Profil chargé et fusionné:", currentUser.name);
    } else {
      // Premier login : on demande les infos
      currentUser = {
        uid: user.uid,
        avatar: user.photoURL,
        email: user.email
      };
      showProfileModal();
    }
  } else {
    currentUser = null;
    playerClientIds = new Set();
    playerAliases = new Set();
    updateAuthUI(null);
    processData();
    renderAll();
    console.log("Utilisateur déconnecté");
  }
});

async function fetchPlayerClientIds(publicId) {
  try {
    const r = await fetch(`https://api.openfront.io/public/player/${publicId}/sessions`);
    if (!r.ok) return;
    const sessions = await r.json();
    
    playerClientIds = new Set(sessions.map(s => s.clientId));
    playerAliases = new Set(sessions.map(s => s.username).filter(Boolean));
    
    console.log(`${playerClientIds.size} Client IDs et ${playerAliases.size} pseudos trouvés pour ${publicId}`);
  } catch (e) {
    console.error("Erreur fetch sessions:", e);
  }
}

function showProfileModal() {
  document.getElementById('profile-modal').classList.add('active');
}

window.saveUserProfile = async () => {
  const username = document.getElementById('profile-username').value.trim();
  const publicId = document.getElementById('profile-public-id').value.trim();

  if (!username || !publicId) {
    alert("Veuillez remplir tous les champs.");
    return;
  }

  try {
    await setDoc(doc(db, "users", currentUser.uid), {
      username: username,
      publicId: publicId,
      email: currentUser.email,
      createdAt: new Date().toISOString()
    });

    currentUser.name = username;
    currentUser.publicId = publicId;
    
    await fetchPlayerClientIds(publicId);
    
    document.getElementById('profile-modal').classList.remove('active');
    updateAuthUI(currentUser);
    processData();
    renderAll();
    alert("Profil enregistré et fusionné avec succès !");
  } catch (error) {
    console.error("Erreur sauvegarde profil:", error);
    alert("Erreur lors de la sauvegarde du profil.");
  }
};

function toggleAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.toggle('active');
}

async function handleLogin(provider) {
  console.log(`Tentative de connexion avec ${provider}...`);
  try {
    let user;
    if (provider === 'google') {
      user = await window.loginWithGoogle();
    } else if (provider === 'discord') {
      user = await window.loginWithDiscord();
    }
    
    // Note: L'UI sera mise à jour automatiquement par onAuthStateChanged
    if (user) {
      toggleAuthModal();
    }
  } catch (error) {
    console.error("Erreur d'authentification:", error);
  }
}

function updateAuthUI(user) {
  const authZone = document.getElementById('auth-zone');
  if (user) {
    authZone.innerHTML = `
      <div class="user-badge" onclick="handleLogout()">
        <span class="user-name">${user.name}</span>
      </div>
    `;
  } else {
    authZone.innerHTML = `
      <button class="login-btn" onclick="toggleAuthModal()">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>Connexion</span>
      </button>
    `;
  }
}

function handleLogout() {
  if (confirm("Voulez-vous vous déconnecter ?")) {
    window.logout();
    currentUser = null;
    updateAuthUI(null);
  }
}

let refreshInterval=null,prevRunCount=0,totalRunsCount=0;
async function loadData(){
  try{
    const r=await fetch("runs.json?_="+Date.now());if(!r.ok)throw new Error("Impossible de récupérer runs.json");
    const data=await r.json();
    
    console.log("Données reçues:", { 
      totalCount: data.totalCount, 
      runsLength: data.runs ? data.runs.length : (Array.isArray(data) ? data.length : "N/A") 
    });

    // Support de l'ancien format (tableau) et du nouveau (objet {runs, totalCount})
    if (data.runs && Array.isArray(data.runs)) {
      allRuns = data.runs;
      totalRunsCount = data.totalCount || allRuns.length;
    } else if (Array.isArray(data)) {
      allRuns = data;
      totalRunsCount = allRuns.length;
    } else {
      throw new Error("Format de données invalide dans runs.json");
    }
    
    processData();
    renderAll();
    
    if(refreshInterval) clearInterval(refreshInterval);
    refreshInterval=setInterval(autoRefresh, 60000);
  }catch(e){
    console.error("Erreur critique chargement:", e);
    document.getElementById("map-list").innerHTML=`<div class="error">Erreur: ${e.message}</div>`;
  }
}

async function autoRefresh(){
  try{
    const r=await fetch("runs.json?_="+Date.now());if(!r.ok)return;
    const data=await r.json();
    const d = (data.runs && Array.isArray(data.runs)) ? data.runs : (Array.isArray(data) ? data : null);
    
    if(!d) return;

    if(d.length !== allRuns.length){
      const newRuns = d.length - allRuns.length;
      allRuns = d;
      totalRunsCount = data.totalCount || allRuns.length;
      processData();
      renderAll();
      updateStats();
      
      const badge = document.getElementById('refresh-badge');
      if(badge) {
        badge.style.display='inline-block';
        setTimeout(()=>badge.style.display='none',5000);
      }
      
      if(newRuns > 0){
        const latest=[...allRuns].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))[0];
        
        // Confetti for new WR
        const mapData=allMaps.find(m=>m.map===latest.map);
        const rank=mapData?mapData.runs.findIndex(x=>x.id===latest.id)+1:0;
        if(rank===1) createConfetti();

        if(latest && Notification.permission==='granted'){
          notifyNewRecord(latest.player+' a gagné sur '+latest.map+' !');
        }
      }
    }
  }catch(e){
    console.error("Erreur auto-refresh:", e);
  }
}
function processData(){
  const ms={};playerStats={};
  
  allRuns.forEach(r=>{
    // Fusion intelligente : par Client ID (nouveaux runs) OU par pseudonyme historique (anciens runs)
    let playerName = r.player;
    let isConnectedUserRun = false;
    
    if (currentUser) {
      const matchById = r.playerId && playerClientIds.has(r.playerId);
      const matchByName = playerAliases.has(r.player);
      
      if (matchById || matchByName) {
        playerName = currentUser.name;
        isConnectedUserRun = true;
      }
    }

    if(!ms[r.map])ms[r.map]={map:r.map,total:0,best:Infinity,runs:[],king:null};
    ms[r.map].total++;
    
    // On clone le run pour ne pas modifier l'original tout en injectant le pseudo fusionné
    const displayRun = { ...r, player: playerName, _isMe: isConnectedUserRun };
    ms[r.map].runs.push(displayRun);
    
    if(r.duration_s < ms[r.map].best) ms[r.map].best = r.duration_s;
    
    if(!playerStats[playerName]) {
      playerStats[playerName] = {
        player: playerName, 
        wins: 0, 
        maps: new Set(), 
        runs: [], 
        totalTime: 0, 
        points: 0, 
        golds: 0, 
        silvers: 0, 
        bronzes: 0, 
        pbs: 0, 
        streak: 0, 
        maxStreak: 0, 
        lastWinDate: null,
        _isMe: isConnectedUserRun
      };
    }
    
    const p = playerStats[playerName];
    const runDate = new Date(r.timestamp).toDateString();
    
    if(p.lastWinDate && new Date(p.lastWinDate).toDateString() === new Date(new Date(runDate)-86400000).toDateString()){
      p.streak++;
    } else if(p.lastWinDate && runDate === p.lastWinDate) {
      // Même jour, on ne change pas la streak
    } else {
      p.streak = 1;
    }
    
    if(runDate !== p.lastWinDate) p.lastWinDate = runDate;
    if(p.streak > p.maxStreak) p.maxStreak = p.streak;
    
    p.wins++;
    p.maps.add(r.map);
    p.runs.push(displayRun);
    p.totalTime += r.duration_s;
  });

  allMaps = Object.values(ms).sort((a,b) => a.map.localeCompare(b.map));
  allMaps.forEach(m => m.runs.sort((a,b) => a.duration_s - b.duration_s));
  
  allMaps.forEach(m => {
    m.runs.forEach((r,i) => {
      const p = playerStats[r.player];
      if(!p) return;
      if(i === 0) {
        p.points += 3;
        p.golds++;
        m.king = r.player;
      } else if(i === 1) {
        p.points += 2;
        p.silvers++;
      } else if(i === 2) {
        p.points += 1;
        p.bronzes++;
      }
    });
    
    // PB detection: for each player, track their best on this map
    const playerBests = {};
    m.runs.forEach(r => {
      if(!playerBests[r.player] || r.duration_s < playerBests[r.player]) {
        playerBests[r.player] = r.duration_s;
      }
    });
    m.runs.forEach(r => {
      if(r.duration_s === playerBests[r.player]) r._isPB = true;
      else r._isPB = false;
    });
  });

  // Count PBs per player
  Object.values(playerStats).forEach(p => {
    p.pbs = p.runs.filter(r => r._isPB).length;
  });
  
  globalLeaderboard = Object.values(playerStats).sort((a,b) => b.points - a.points || a.totalTime - b.totalTime);
}
function renderAll(){renderMaps();renderFeed();updateStats();updateLastUpdate();renderGlobal();renderCharts();renderCompare()}
function updateStats(){
  document.getElementById("stat-runs").textContent=totalRunsCount.toLocaleString("fr");
  document.getElementById("stat-maps").textContent=allMaps.length;
  document.getElementById("stat-players").textContent=Object.keys(playerStats).length;
  const bt=allMaps.length?Math.min(...allMaps.map(m=>m.best)):0;
  document.getElementById("stat-best").textContent=bt>0?formatTime(bt):"—";
}
function updateLastUpdate(){
  if(allRuns.length){const lr=allRuns.reduce((l,r)=>new Date(r.timestamp)>new Date(l.timestamp)?r:l,allRuns[0]);
  document.getElementById("last-update").innerHTML="Dernière mise à jour : "+new Date(lr.timestamp).toLocaleString("fr-FR")+'<span class="refresh-badge" id="refresh-badge" style="display:none">LIVE</span>'}
}
function renderMaps(){
  const c=document.getElementById("map-list"),q=document.getElementById("map-search").value.toLowerCase();
  const f=q?allMaps.filter(m=>m.map.toLowerCase().includes(q)):allMaps;
  if(!f.length){c.innerHTML='<div class="empty-state"><p>Aucune carte</p></div>';return}
  c.innerHTML=f.map(m=>'<div class="map-item '+(activeMap===m.map?"active":"")+'" onclick="selectMap(\''+esc(m.map)+'\')"><span class="map-name">'+m.map+'</span><span class="map-count">'+m.total+'</span></div>').join("");
}
function filterMaps(){renderMaps()}
function selectMap(name){
  activeMap=name;mapShowCount[name]=10;renderMaps();
  const d=allMaps.find(m=>m.map===name);if(!d)return;
  document.getElementById("content-title").textContent=name;
  document.getElementById("content-meta").textContent=d.total+" runs · Meilleur : "+formatTime(d.best);
  document.getElementById("share-btn").style.display='inline-flex';
  renderLeaderboard(d);updateURL();
}
function renderLeaderboard(d){
  const show=mapShowCount[d.map]||10;const best=d.runs[0]?.duration_s||0;
  const now=Date.now();
  let html=d.runs.slice(0,show).map((r,i)=>{
    const rc=i===0?"gold":i===1?"silver":i===2?"bronze":"";
    const gap=i>0?"+"+formatTime(r.duration_s-best):"";
    const diff=r.difficulty?'<span class="run-diff">'+r.difficulty+'</span>':'';
    const age=now-new Date(r.timestamp).getTime();
    const isNew=age<3600000?'<span class="badge-new">NEW</span>':'';
    const isMeClass = r._isMe ? 'is-me' : '';
    return '<div class="run-row '+isMeClass+'"><div class="run-rank '+rc+'">'+(i+1)+'</div><div class="run-player" onclick="showPlayer(\''+esc(r.player)+'\')">'+r.player+diff+isNew+'</div><a class="run-replay" href="'+getRunUrl(r)+'" target="_blank" title="Voir le replay">&#9654;</a><div class="run-time">'+formatTime(r.duration_s)+'</div><div class="run-gap">'+gap+'</div></div>';
  }).join("");
  if(d.runs.length>show)html+='<button class="see-more-btn" onclick="seeMore(\''+esc(d.map)+'\')">Voir plus ('+(d.runs.length-show)+' restants)</button>';
  document.getElementById("leaderboard").innerHTML=html;
}
function seeMore(map){mapShowCount[map]=(mapShowCount[map]||10)+10;const d=allMaps.find(m=>m.map===map);if(d)renderLeaderboard(d)}
function shareMap(){
  if(!activeMap)return;
  const url=window.location.origin+window.location.pathname+'?map='+encodeURIComponent(activeMap);
  navigator.clipboard.writeText(url).then(()=>{const b=document.getElementById('share-btn');b.textContent='✓ Copié !';setTimeout(()=>b.textContent='🔗 Partager',2000)});
}
function timeAgo(ts){
  const s=Math.floor((Date.now()-new Date(ts).getTime())/1000);
  if(s<60)return "à l'instant";
  if(s<3600)return "il y a "+Math.floor(s/60)+" min";
  if(s<86400)return "il y a "+Math.floor(s/3600)+" h";
  const d=Math.floor(s/86400);
  return "il y a "+d+" j";
}
function renderFeed(){
  const c=document.getElementById("feed-list");
  const recent=[...allRuns].sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,10);
  if(!recent.length){c.innerHTML='<div class="empty-state"><p>Aucune victoire</p></div>';return}
  c.innerHTML=recent.map((r,i)=>{
    const mapData=allMaps.find(m=>m.map===r.map);
    const rank=mapData?mapData.runs.findIndex(x=>x.id===r.id)+1:0;
    const isTop3=rank<=3&&rank>0;
    const rankBadge=isTop3?'<span class="feed-rank-badge rank-'+rank+'">#'+rank+'</span>':'';
    const age=Date.now()-new Date(r.timestamp).getTime();
    const isNew=age<3600000?'<span class="badge-new">NEW</span>':'';
    return '<div class="feed-item"><div class="feed-rank">'+(i+1)+'</div><div class="feed-info"><div class="feed-player" onclick="showPlayer(\''+esc(r.player)+'\')">'+r.player+isNew+rankBadge+'</div><div class="feed-map">'+r.map+' · '+timeAgo(r.timestamp)+'</div></div><div class="feed-time">'+formatTime(r.duration_s)+'</div><a class="feed-replay" href="'+getRunUrl(r)+'" target="_blank" title="Voir le replay">&#9654;</a></div>';
  }).join("");
}
function renderGlobal(){
  const c=document.getElementById("global-list");
  if(!c) return; // Sécurité si l'élément n'existe pas
  if(!globalLeaderboard.length){c.innerHTML='<div class="empty-state"><p>Aucun joueur</p></div>';return}
  
  // Animate ranking changes
  if (previousGlobalLeaderboard.length > 0) {
    setTimeout(animateRanking, 100);
  }
  
  // Save current leaderboard for next comparison
  previousGlobalLeaderboard = globalLeaderboard.slice(0,50).map((p,i) => ({player: p.player, rank: i+1}));
  
  c.innerHTML='<table class="global-table"><thead><tr><th>#</th><th>Joueur</th><th>Points</th><th>Victoires</th></tr></thead><tbody>'+
    globalLeaderboard.slice(0,50).map((p,i)=>{
      const rc = i===0?'gold':i===1?'silver':i===2?'bronze':'';
      const isMeClass = p._isMe ? 'is-me' : '';
      return '<tr class="'+isMeClass+'"><td class="global-rank '+rc+'">'+(i+1)+'</td><td class="global-player" onclick="showPlayer(\''+esc(p.player)+'\')">'+p.player+'</td><td class="global-points">'+p.points+'</td><td class="global-wins">'+p.wins+'</td></tr>';
    }).join("")+'</tbody></table>';
}
function renderHof(){
  const c=document.getElementById("hof-list");
  if(globalLeaderboard.length<1){c.innerHTML='<div class="empty-state"><p>Pas encore de joueurs</p></div>';return}
  c.innerHTML=globalLeaderboard.slice(0,3).map((p,i)=>{
    const rank=getRank(p.points);
    return '<div class="hof-card hof-'+(i+1)+'"><div class="hof-name" onclick="showPlayer(\''+esc(p.player)+'\')">'+p.player+'</div><div class="hof-rank" style="color:'+rank.color+'">'+rank.name+'</div><div class="hof-pts">'+p.points+' pts</div><div class="hof-detail">'+p.golds+' 1er · '+p.silvers+' 2e · '+p.bronzes+' 3e</div></div>';
  }).join("");
}
function renderCompare(){
  const c=document.getElementById("compare-list");
  if(comparePlayers.length<2){c.innerHTML='<div class="empty-state"><h3>Comparaison</h3><p>Recherchez 2 joueurs ci-dessus pour les comparer</p></div>';return}
  const p1=playerStats[comparePlayers[0]],p2=playerStats[comparePlayers[1]];
  if(!p1||!p2){c.innerHTML='<div class="empty-state"><p>Joueur introuvable</p></div>';return}
  const r1=getRank(p1.points),r2=getRank(p2.points);
  const rows=[
    {label:'Rang',v1:r1.name,v2:r2.name},
    {label:'Points',v1:p1.points,v2:p2.points},
    {label:'1er',v1:p1.golds,v2:p2.golds},
    {label:'2e',v1:p1.silvers,v2:p2.silvers},
    {label:'3e',v1:p1.bronzes,v2:p2.bronzes},
    {label:'Victoires',v1:p1.wins,v2:p2.wins},
    {label:'Cartes',v1:p1.maps.size,v2:p2.maps.size},
    {label:'Tps moyen',v1:formatTime(Math.round(p1.totalTime/p1.wins)),v2:formatTime(Math.round(p2.totalTime/p2.wins))},
    {label:'Streak max',v1:p1.maxStreak,v2:p2.maxStreak}
  ];
  c.innerHTML='<table class="global-table"><thead><tr><th></th><th class="global-player" onclick="showPlayer(\''+esc(p1.player)+'\')">'+p1.player+'</th><th class="global-player" onclick="showPlayer(\''+esc(p2.player)+'\')">'+p2.player+'</th></tr></thead><tbody>'+
    rows.map(r=>'<tr><td class="compare-label">'+r.label+'</td><td class="compare-val">'+r.v1+'</td><td class="compare-val">'+r.v2+'</td></tr>').join("")+
    '</tbody></table>';
}
function addCompare(name){
  if(comparePlayers.includes(name))comparePlayers=comparePlayers.filter(p=>p!==name);
  else if(comparePlayers.length>=2)comparePlayers=[comparePlayers[1],name];
  else comparePlayers.push(name);
  renderCompare();updateCompareInputs();
}
function updateCompareInputs(){
  const i1=document.getElementById('cmp1'),i2=document.getElementById('cmp2');
  if(i1)i1.value=comparePlayers[0]||'';if(i2)i2.value=comparePlayers[1]||'';
}
function searchCompare(id){
  const q=document.getElementById(id).value.toLowerCase().trim();
  const c=document.getElementById(id+'-results');
  if(!q){c.innerHTML='';return}
  const m=globalLeaderboard.filter(p=>p.player.toLowerCase().includes(q)).slice(0,3);
  c.innerHTML=m.map(p=>'<div class="cmp-result" onclick="addCompare(\''+esc(p.player)+'\');document.getElementById(\''+id+'-results\').innerHTML=\'\'">'+p.player+' ('+p.points+' pts)</div>').join("");
}
function renderCharts(){
  renderPopularMaps();
  renderDistChart();
}

function renderPopularMaps(){
  const mapCounts={};
  allRuns.forEach(r=>{mapCounts[r.map]=(mapCounts[r.map]||0)+1});
  const sortedMaps=Object.entries(mapCounts).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const maxCount=Math.max(...sortedMaps.map(x=>x[1]),1);
  document.getElementById("popular-maps").innerHTML=sortedMaps.map(([map,count])=>
    '<div class="dist-row"><span class="dist-label">'+map+'</span><div class="dist-bar" style="width:'+Math.max(4,count/maxCount*200)+'px;height:16px;background:var(--accent)"></div><span class="dist-count">'+count+'</span></div>'
  ).join("");
}

function renderDistChart(){
  const buckets={};const bucketSize=60;
  allRuns.forEach(r=>{const b=Math.floor(r.duration_s/bucketSize)*bucketSize;const k=formatTime(b);buckets[k]=(buckets[k]||0)+1});
  const sorted=Object.entries(buckets).sort((a,b)=>parseInt(a[0])-parseInt(b[0]));
  const maxB=Math.max(...sorted.map(x=>x[1]),1);
  document.getElementById("dist-chart").innerHTML=sorted.map(([k,v])=>
    '<div class="dist-row"><span class="dist-label">'+k+'</span><div class="dist-bar" style="width:'+Math.max(4,v/maxB*200)+'px;height:16px"></div><span class="dist-count">'+v+'</span></div>'
  ).join("");
}
function searchPlayer(){
  const q=document.getElementById("player-search").value.toLowerCase().trim();
  const c=document.getElementById("search-results");
  if(!q){c.innerHTML='';return}
  const matches=globalLeaderboard.filter(p=>p.player.toLowerCase().includes(q)).slice(0,5);
  if(!matches.length){c.innerHTML='<div class="feed-card" style="padding:16px"><p style="color:var(--text2)">Aucun joueur trouvé</p></div>';return}
  c.innerHTML='<div class="feed-card">'+matches.map(p=>{
    const rank=getRank(p.points);
    return '<div class="feed-item" onclick="showPlayer(\''+esc(p.player)+'\')"><div class="feed-rank">'+p.points+'</div><div class="feed-info"><div class="feed-player">'+p.player+'</div><div class="feed-map">'+rank.name+' · '+p.wins+' victoires · '+p.maps.size+' cartes</div></div></div>';
  }).join("")+'</div>';
}
function showPlayer(name){
  const p=playerStats[name];if(!p)return;
  const rank=getRank(p.points);
  document.getElementById("modal-player-name").innerHTML=name+' <span class="rank-badge" style="color:'+rank.color+'">'+rank.name+'</span>';
  document.getElementById("modal-player-stats").textContent=p.wins+" runs · "+p.maps.size+" cartes · "+p.points+" pts";
  document.getElementById("modal-wins").textContent=p.wins;
  document.getElementById("modal-maps").textContent=p.maps.size;
  document.getElementById("modal-avg").textContent=formatTime(Math.round(p.totalTime/p.wins));
  const sortedRuns=[...p.runs].sort((a,b)=>a.duration_s-b.duration_s);
  document.getElementById("modal-runs").innerHTML=sortedRuns.map(r=>{
    const mapData=allMaps.find(m=>m.map===r.map);
    const rank2=mapData?mapData.runs.findIndex(x=>x.id===r.id)+1:0;
    const isPB=r._isPB?'<span class="badge-pb">PB</span>':'';
    
    // Calculate hypothetical ranking on this map
    let hypothRank = '';
    if (rank2 > 1) {
      const betterRuns = mapData ? mapData.runs.filter(run => run.duration_s < r.duration_s).length : 0;
      hypothRank = '<span style="color:var(--text3);font-size:11px;margin-left:8px">(Si vous étiez sur cette map: #'+(betterRuns+1)+')</span>';
    }
    
    return '<div class="player-run-row"><div class="player-run-map">'+r.map+'</div><div class="player-run-rank">#'+rank2+'</div><div class="player-run-time">'+formatTime(r.duration_s)+'</div><a class="run-replay" href="'+getRunUrl(r)+'" target="_blank" title="Voir le replay" style="width:26px;height:26px;font-size:11px">&#9654;</a></div>';
  }).join("");
  document.getElementById("player-modal").classList.add("active");
  updateURL();
}
function closeModal(e){
  if(!e||e.target.id==="player-modal")document.getElementById("player-modal").classList.remove("active");
  updateURL();
}
function switchTab(name,btn){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-'+name).classList.add('active');
  updateURL();
}
function updateURL(){
  const p=new URLSearchParams();
  const activeTab=document.querySelector('.tab-btn.active');
  if(activeTab){const tabs=['maps','global','stats'];const idx=[...document.querySelectorAll('.tab-btn')].indexOf(activeTab);if(idx>0&&tabs[idx])p.set('tab',tabs[idx])}
  if(activeMap)p.set('map',activeMap);
  const h=window.location.pathname+(p.toString()?'?'+p:'');
  history.replaceState(null,'',h);
}
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeModal();document.getElementById("settings-panel").classList.remove("active")}});

// Init
const savedTheme=localStorage.getItem('theme')||'blue';
applyTheme(savedTheme);
if(localStorage.getItem('lightMode')==='1'){document.documentElement.classList.add('light');document.getElementById('theme-toggle').classList.add('on')}
const urlParams=new URLSearchParams(window.location.search);
const mapParam=urlParams.get('map');
const tabParam=urlParams.get('tab');
loadData().then(()=>{
  if(mapParam)selectMap(mapParam);
  if(tabParam){
    const btns=document.querySelectorAll('.tab-btn');
    const tabs=['maps','global','stats'];
    const idx=tabs.indexOf(tabParam);
    if(idx>=0&&btns[idx])switchTab(tabParam,btns[idx]);
  }
});

// Export functions to window for HTML event handlers
window.toggleSettings = toggleSettings;
window.toggleLightMode = toggleLightMode;
window.requestNotifs = requestNotifs;
window.applyTheme = applyTheme;
window.toggleAuthModal = toggleAuthModal;
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.selectMap = selectMap;
window.seeMore = seeMore;
window.shareMap = shareMap;
window.showPlayer = showPlayer;
window.addCompare = addCompare;
window.searchCompare = searchCompare;
window.searchPlayer = searchPlayer;
window.filterMaps = filterMaps;
window.switchTab = switchTab;
window.closeModal = closeModal;
