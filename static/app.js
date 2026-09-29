/* Stara Zagora Transit v2. All vehicle markers originate in the public live feed. */
'use strict';
const C = window.TransitCore;
const GPS_REFRESH_SECONDS = 10;
const $ = id => document.getElementById(id);
const E = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = value => String(value ?? '').toLocaleLowerCase('bg').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const storage = { get(key, fallback) { try { return JSON.parse(localStorage.getItem('sz.' + key)) ?? fallback; } catch { return fallback; } }, set(key, value) { try { localStorage.setItem('sz.' + key, JSON.stringify(value)); return true; } catch { return false; } } };
const defaults = { theme: 'light', mapStyle: 'soft', showStops: true, showVehicles: true, showLines: false, autoRefresh: true };
const storedSettings = storage.get('settings', {});
const settings = { ...defaults, ...(storedSettings && typeof storedSettings === 'object' ? storedSettings : {}) };
const savedFavorites = storage.get('favorites', {});
const favorites = { routes: new Set(Array.isArray(savedFavorites?.routes) ? savedFavorites.routes : []), stops: new Set(Array.isArray(savedFavorites?.stops) ? savedFavorites.stops : []) };
const S = { data:null, core:null, map:null, tab:'routes', view:{kind:'home'}, type:'all', selectedRoute:null, pattern:null,
  vehicleData:{status:'loading',vehicles:[],updated:null}, vehicleMarkers:new Map(), stopMarkers:new Map(), follow:null,
  nearby:null, choosingPoint:false, stopsLayer:null, routeLayer:null, allLines:null, vehiclesLayer:null, journeyLayer:null,
  locationLayer:null, routeDate:null, stopDate:null, stopTime:null, stopRoute:'', fullDay:false, journeyResults:[], selectedJourney:-1,
  planner:{from:'',to:'',date:C.now().date,time:C.now().text,transfers:true,walk:true}, loadingGPS:false, liveRoute:'', tileErrors:0 };
const route = id => S.core?.routes.get(id);
const stop = id => S.core?.stops.get(id);
const pattern = id => S.data?.patterns[id];
const vehicle = id => S.vehicleData.vehicles.find(v => v.id === id);
const color = rid => route(rid)?.type === 11 ? '#345fa9' : '#236654';
const badge = (rid, small = false) => `<span class="route-badge ${route(rid)?.type === 11 ? 'trolley' : ''} ${small ? 'small' : ''}">${E(route(rid)?.name || rid || '?')}</span>`;
const routeName = rid => route(rid)?.name || rid;
const vehicleTypeLabel = v => ({bus:'Автобус',electric_bus:'Електробус',articulated_bus:'Съчленен автобус',trolley:'Тролейбус'})[v.vehicle_type] || (route(v.route)?.type===11?'Тролейбусна линия':route(v.route)?'Автобусна линия':'Неуточнен вид');
function vehicleInfo(v) {
  const source = /^https?:\/\//i.test(v.model_source||'') ? `<a href="${E(v.model_source)}" target="_blank" rel="noopener">Източник за модела ↗</a>` : '';
  return `<div class="vehicle-info"><strong>${E(v.model||'Моделът не е установен')}</strong><span>${E(vehicleTypeLabel(v))}${v.label?' · бордов № '+E(v.label):''}</span>${v.license_plate?`<span>Рег. / служебен № ${E(v.license_plate)}</span>`:''}${v.model_source_note?`<small>${E(v.model_source_note)}</small>`:''}${source}</div>`;
}

const empty = (title, text = '') => `<div class="empty"><strong>${E(title)}</strong>${E(text)}</div>`;
const metaDate = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('bg-BG', {day:'numeric',month:'long',weekday:'short',timeZone:'Europe/Sofia'});
const expiry = date => Boolean(S.data.feed_end && date.replaceAll('-', '') > S.data.feed_end);
function calendarNote(date) {
  if (expiry(date)) return '<div class="notice">Тази дата е след края на публикуваното разписание. Обнови данните, преди да планираш пътуване.</div>';
  const active = new Set(S.data.trips.map(t => t.service));
  if (![...active].some(s => C.serviceActive(S.data,s,date))) return '<div class="notice">За този ден няма публикувано обслужване в наличните данни. Това не означава, че в града няма транспорт.</div>';
  return '';
}
function toast(text) { $('toast').textContent=text; $('toast').hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('toast').hidden=true,5000); }
function favoriteButton(kind,id) { const saved=favorites[kind].has(id); return `<button class="star ${saved?'saved':''}" data-favorite="${kind}" data-id="${E(id)}" aria-label="${saved?'Премахни от':'Добави в'} любими" aria-pressed="${saved}">${saved?'★':'☆'}</button>`; }
function routeButton(r) { const p=pattern(r.patterns[0]), n=S.vehicleData.vehicles.filter(v=>v.route===r.id).length; return `<button class="line-row" data-route="${E(r.id)}">${badge(r.id)}<span class="route-copy"><strong>${E(p?.head || r.long_name)}</strong><small>${r.type===11?'Тролейбус':'Автобус'} · ${r.stop_count} спирки · ${r.patterns.length} варианта</small></span>${n?`<span class="live-count">${n} GPS</span>`:'<span class="arrow">›</span>'}</button>`; }
function stopButton(s, metres) { return `<button class="stop-card" data-stop="${E(s.id)}"><span class="stop-symbol">◉</span><span class="stop-copy"><strong>${E(s.name)}</strong><small>№ ${E(s.code||s.id)} · ${s.routes.map(r=>E(routeName(r))).join(', ')||'Без линии'}</small></span>${metres!=null?`<small>${metres>=1000?(metres/1000).toFixed(1)+' км':Math.round(metres)+' м'}</small>`:''}</button>`; }
function departureRows(items, date) {
  if (!items.length) return empty('Няма публикувани заминавания', 'Промени датата или виж целия ден.');
  const now=C.now();
  return `<div class="departures">${items.map(d=>{const p=pattern(d.trip.pattern),mins=Math.ceil((d.time-now.seconds)/60),day=Math.floor(d.time/C.DAY);return `<button class="departure" data-trip="${E(d.trip.id)}" data-date="${E(d.serviceDate)}" data-index="${d.index}">${badge(d.trip.route,true)}<span class="destination"><strong>${E(p?.head)}</strong><small>По разписание · виж курса</small></span><span class="time-block"><time>${C.clock(d.time)}${day>0?' +'+day:''}</time><small>${date===now.date&&mins>=0&&mins<180?(mins===0?'сега':mins+' мин'):(day>0?'следващ ден':'')}</small></span></button>`;}).join('')}</div>`;
}
function backButton() { return '<button class="back" data-action="back">← Назад към справочника</button>'; }
function render() {
  if (!S.data) return;
  document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===S.tab);b.setAttribute('aria-current',b.dataset.tab===S.tab?'page':'false');});
  const q=norm($('search').value);
  let html;
  if(q) html=renderSearch(q);
  else if(S.view.kind==='route') html=renderRoute();
  else if(S.view.kind==='stop') html=renderStop();
  else if(S.view.kind==='vehicle') html=renderVehicle();
  else if(S.view.kind==='trip') html=renderTrip();
  else html={routes:renderRoutes,journey:renderJourney,nearby:renderNearby,favorites:renderFavorites,live:renderLive}[S.tab]();
  $('panel-content').innerHTML=html;
  renderSummary();
}
function renderRoutes() {
  const list=S.data.routes.filter(r=>S.type==='all'||(r.type===11?'trolley':'bus')===S.type);
  return `<div class="eyebrow">Градът е в движение</div><div class="section-top"><h1>Намери своята линия</h1></div><p class="muted">Маршрути, спирки и часове на едно място.</p><div class="chips">${[['all','Всички'],['bus','Автобуси'],['trolley','Тролейбуси']].map(([id,title])=>`<button class="chip ${S.type===id?'active':''}" data-type="${id}">${title}</button>`).join('')}</div><div class="section-label"><span>Линии</span><span>${list.length} в мрежата</span></div><div class="line-list">${list.map(routeButton).join('')}</div><div class="note">Избери линия, после посока. Натисни спирка за заминаванията или автобус за последната му GPS позиция.</div>`;
}
function renderSearch(q) {
  const rs=S.data.routes.filter(r=>norm(r.name)===q||norm(r.long_name).includes(q)||r.patterns.some(id=>norm(pattern(id).head).includes(q))).sort((a,b)=>(norm(b.name)===q)-(norm(a.name)===q));
  const ss=S.data.stops.filter(s=>norm(s.name).includes(q)||norm(s.code||s.id)===q);
  return `<div class="section-top"><h2>Резултати</h2><span class="count">${rs.length+ss.length}</span></div>${rs.length?`<div class="section-label">Линии</div><div class="line-list">${rs.slice(0,15).map(routeButton).join('')}</div>`:''}${ss.length?`<div class="section-label">Спирки · ${ss.length}</div>${ss.slice(0,50).map(s=>stopButton(s)).join('')}`:''}${!rs.length&&!ss.length?empty('Няма съвпадения','Опитай име на спирка или номер на линия.'):''}${ss.length>50?'<p class="muted">Показани са първите 50 спирки. Уточни търсенето.</p>':''}`;
}
function renderRoute() {
  const r=route(S.view.id);if(!r)return empty('Линията липсва');
  const p=pattern(S.pattern)||pattern(r.patterns[0]), n=S.vehicleData.vehicles.filter(v=>v.route===r.id).length;
  const date=S.routeDate||C.now().date, fromTime=date===C.now().date?C.now().seconds:0;
  const deps=p?S.core.departures(p.stops[0],date,fromTime,{pattern:p.id,horizon:C.DAY-fromTime,limit:5}):[];
  return `${backButton()}<div class="eyebrow">${r.type===11?'Тролейбусна':'Автобусна'} линия</div><div class="detail-title">${badge(r.id)}<div><h2>Линия ${E(r.name)}</h2><p class="muted">${E(r.long_name)}</p></div>${favoriteButton('routes',r.id)}</div><div class="actions"><button class="button secondary" data-action="share">↗ Сподели</button><button class="button secondary" data-live-route="${E(r.id)}">● На живо (${n})</button></div><label class="field"><span>Посока и вариант на маршрута</span><select id="route-pattern">${r.patterns.map((id,i)=>{const a=pattern(id);return `<option value="${E(id)}" ${id===p?.id?'selected':''}>${E(a.head)} · ${a.stops.length} спирки · вариант ${i+1}</option>`;}).join('')}</select></label>${p?`<p class="muted">От ${E(stop(p.stops[0])?.name)} до ${E(stop(p.stops.at(-1))?.name)}</p><div class="section-label"><span>Спирки в тази посока</span><span>${p.stops.length}</span></div><ol class="timeline">${p.stops.map((sid,i)=>`<li><button data-stop="${E(sid)}"><span>${E(stop(sid)?.name)}</span><small>${i+1}</small></button></li>`).join('')}</ol><label class="field"><span>Курсове от началната спирка за дата</span><input type="date" id="route-date" value="${date}"></label>${calendarNote(date)}${departureRows(deps,date)}`:empty('Липсва маршрут')}`;
}
function renderStop() {
  const s=stop(S.view.id);if(!s)return empty('Спирката липсва');
  const now=C.now(),date=S.stopDate||now.date;
  const time=S.fullDay?0:(S.stopTime?Number(S.stopTime.slice(0,2))*3600+Number(S.stopTime.slice(3))*60:(date===now.date?now.seconds:0));
  const deps=S.core.departures(s.id,date,time,{route:S.stopRoute||null,horizon:S.fullDay?C.DAY:4*3600,limit:S.fullDay?400:16});
  return `${backButton()}<div class="eyebrow">Спирка № ${E(s.code||s.id)}</div><div class="detail-title"><div><h2>${E(s.name)}</h2><p class="muted">${s.routes.length} линии · ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</p></div>${favoriteButton('stops',s.id)}</div><div class="route-strip">${s.routes.map(rid=>`<button data-route="${E(rid)}" aria-label="Линия ${E(routeName(rid))}">${badge(rid,true)}</button>`).join('')}</div><div class="actions"><button class="button" data-plan-from="${E(s.id)}">Оттук</button><button class="button secondary" data-plan-to="${E(s.id)}">Дотук</button><button class="button secondary" data-action="share">↗ Сподели</button></div><div class="field-row"><label class="field"><span>Дата</span><input id="stop-date" type="date" value="${date}"></label><label class="field"><span>След час</span><input id="stop-time" type="time" value="${S.stopTime||(date===now.date?now.text:'00:00')}" ${S.fullDay?'disabled':''}></label></div><label class="field"><span>Линия</span><select id="stop-route"><option value="">Всички линии</option>${s.routes.map(rid=>`<option value="${E(rid)}" ${S.stopRoute===rid?'selected':''}>Линия ${E(routeName(rid))}</option>`).join('')}</select></label><div class="chips"><button class="chip ${!S.fullDay?'active':''}" data-action="next-departures">Следващи</button><button class="chip ${S.fullDay?'active':''}" data-action="all-departures">Цял ден</button><button class="chip" data-action="departures-now">Сега</button></div>${calendarNote(date)}<div class="section-label"><span>По разписание</span><span>${metaDate(date)}</span></div><div id="stop-departures">${departureRows(deps,date)}</div><p class="note">Показаните часове не са GPS прогнози. В противоположната посока обикновено има отделна спирка със собствено разписание.</p>`;
}
function renderTrip() {
  const t=S.core.trips.get(S.view.id);if(!t)return empty('Курсът липсва');
  const p=pattern(t.pattern), date=S.view.date||C.now().date;
  return `${backButton()}<div class="eyebrow">Курс по разписание · ${metaDate(date)}</div><div class="detail-title">${badge(t.route)}<div><h2>Към ${E(p.head)}</h2><p class="muted">${C.clock(t.times[0][2])} – ${C.clock(t.times.at(-1)[1])} · ${Math.round((t.times.at(-1)[1]-t.times[0][2])/60)} мин · ${t.times.length} спирки</p></div></div><div class="actions"><button class="button secondary" data-route="${E(t.route)}">Линия ${E(routeName(t.route))}</button><button class="button secondary" data-action="share">↗ Сподели</button><button class="button secondary" data-action="print">Печат</button></div><ol class="timeline">${t.times.map((x,i)=>`<li><button data-stop="${E(x[0])}"><span>${E(stop(x[0])?.name)}${i===S.view.index?' <small>· избрана спирка</small>':''}${x[3]===1?' <small>· без качване</small>':''}</span><time>${C.clock(i===t.times.length-1?x[1]:x[2])}${x[2]>=C.DAY?' +'+Math.floor(x[2]/C.DAY):''}</time></button></li>`).join('')}</ol><div class="note">Това е публикуван курс. Часовете не включват промени от текущото движение.</div>`;
}
function ageText(stamp) { const age=Math.max(0,Math.round(Date.now()/1000-stamp));return age<60?`${age} сек`:`${Math.floor(age/60)} мин ${age%60} сек`; }
function renderVehicle() {
  const v=vehicle(S.view.id);
  if(!v)return `${backButton()}${empty('Позицията вече не е актуална','Това превозно средство не присъства в последния отговор. Избери друго от „На живо“.')}`;
  const r=route(v.route);
  return `${backButton()}<div class="eyebrow">Последна получена GPS позиция</div><div class="detail-title">${badge(v.route)}<div><h2>${r?'Линия '+E(r.name):'Превозно средство'}</h2><p class="muted">${E(v.label||v.id)}${v.label&&v.label!==v.id?' · ID '+E(v.id):''}</p></div></div>${vehicleInfo(v)}<div class="metrics"><div class="metric"><strong>${Number.isFinite(v.speed)?Math.round(v.speed):'—'}</strong><small>км/ч от GPS</small></div><div class="metric"><strong>${Math.max(0,Math.floor(Date.now()/1000-v.time))}</strong><small>сек от позицията</small></div><div class="metric"><strong>${Number.isFinite(v.bearing)?Math.round(v.bearing)+'°':'—'}</strong><small>посока от GPS</small></div></div><div class="actions"><button class="button" data-follow="${E(v.id)}">${S.follow===v.id?'Спри проследяването':'⌖ Следи на картата'}</button>${r?`<button class="button secondary" data-route="${E(r.id)}">Виж линията</button>`:''}<button class="button secondary" data-action="share">↗ Сподели</button></div><div class="note">Последна позиция в ${new Date(v.time*1000).toLocaleTimeString('bg-BG',{timeZone:'Europe/Sofia'})}. Проверяваме за нови позиции на ${GPS_REFRESH_SECONDS} секунди. Празна стойност означава, че източникът не я е предоставил.</div>`;
}
function renderLive() {
  const rows=S.vehicleData.vehicles.filter(v=>!S.liveRoute||v.route===S.liveRoute);
  return `<div class="eyebrow">Поглед към движението</div><div class="section-top"><h1>На живо</h1><span class="count">${rows.length} GPS позиции</span></div><p class="muted">Избери превозно средство, за да го проследиш.</p><label class="field"><span>Линия</span><select id="live-route"><option value="">Всички линии</option>${S.data.routes.map(r=>`<option value="${E(r.id)}" ${S.liveRoute===r.id?'selected':''}>Линия ${E(r.name)}</option>`).join('')}</select></label><button class="button secondary full" data-action="refresh">↻ Обнови сега</button><div class="section-label"><span>Последни позиции</span><span>${settings.autoRefresh?'Авто · '+GPS_REFRESH_SECONDS+' сек':'Обновяването е спряно'}</span></div>${rows.length?rows.map(v=>`<button class="line-row" style="margin-bottom:7px" data-vehicle="${E(v.id)}">${badge(v.route)}<span class="route-copy"><strong>${E(v.label||v.id)}${v.model?" · "+E(v.model):""}</strong><small>${E(vehicleTypeLabel(v))} · Преди ${ageText(v.time)}${Number.isFinite(v.speed)?' · '+Math.round(v.speed)+' км/ч':''}</small></span><span class="arrow">›</span></button>`).join(''):empty('Няма актуални позиции',S.vehicleData.message||'Изчакай следващото обновяване.')}`;
}
function renderFavorites() {
  const rs=[...favorites.routes].map(route).filter(Boolean),ss=[...favorites.stops].map(stop).filter(Boolean);
  return `<div class="eyebrow">Твоите ежедневни пътувания</div><div class="section-top"><h1>Любими</h1><span class="count">${rs.length+ss.length}</span></div><p class="muted">Запазени в този браузър, без регистрация.</p>${!rs.length&&!ss.length?empty('Дръж удобните спирки подръка','Натисни ☆ в страницата на линия или спирка.'):''}${rs.length?`<div class="section-label">Линии</div><div class="line-list">${rs.map(routeButton).join('')}</div>`:''}${ss.length?`<div class="section-label">Спирки</div>${ss.map(s=>stopButton(s)).join('')}`:''}`;
}
function renderNearby() {
  const origin=S.nearby;
  const nearest=origin?S.data.stops.map(s=>({s,d:C.distance(origin,s)})).sort((a,b)=>a.d-b.d).slice(0,12):[];
  return `<div class="eyebrow">Намери началната си спирка</div><div class="section-top"><h1>Наблизо</h1></div><p class="muted">Спирки около теб или около избрана точка.</p><div class="actions"><button class="button" data-action="locate">⌖ Моето място</button><button class="button secondary" data-action="pick-point">${S.choosingPoint?'Откажи избора':'Избери от карта'}</button></div>${S.choosingPoint?'<div class="notice">Натисни свободно място върху картата.</div>':''}${origin?`<div class="note">Около ${origin.source==='gps'?'твоето местоположение':'избраната точка'}. Разстоянията са по права линия.</div><div class="section-label">Най-близки спирки</div>${nearest.map(x=>stopButton(x.s,x.d)).join('')}`:empty('Избери отправна точка','Бутонът „Избери от карта“ работи и когато сайтът е отворен през HTTP.')}`;
}
function stopLabel(id) { const s=stop(id);return s?`${s.name} · № ${s.code||s.id} [${s.id}]`:''; }
function readStopInput(value) { const id=value.match(/\[([^\]]+)\]$/)?.[1];if(id&&stop(id))return id;const matches=S.data.stops.filter(s=>norm(s.name)===norm(value)||s.id===value);return matches.length===1?matches[0].id:''; }
function renderJourney() {
  const p=S.planner;
  return `<div class="eyebrow">От спирка до спирка</div><div class="section-top"><h1>Планирай пътуване</h1></div><p class="muted">Директна връзка или едно прекачване по разписание.</p><form id="journey-form"><label class="field"><span>От спирка</span><input id="journey-from" list="stop-options" autocomplete="off" placeholder="Начална спирка" value="${E(stopLabel(p.from))}" required></label><button class="swap" type="button" data-action="swap" aria-label="Размени начална и крайна спирка">⇅</button><label class="field"><span>До спирка</span><input id="journey-to" list="stop-options" autocomplete="off" placeholder="Крайна спирка" value="${E(stopLabel(p.to))}" required></label><datalist id="stop-options">${S.data.stops.map(s=>`<option value="${E(stopLabel(s.id))}"></option>`).join('')}</datalist><div class="field-row"><label class="field"><span>Дата</span><input type="date" id="journey-date" value="${p.date}" required></label><label class="field"><span>Тръгване след</span><input type="time" id="journey-time" value="${p.time}" required></label></div><label class="toggle-row"><input id="journey-transfers" type="checkbox" ${p.transfers?'checked':''}>Позволи едно прекачване</label><label class="toggle-row"><input id="journey-walk" type="checkbox" ${p.walk?'checked':''}>Смяна на спирката до 200 м при прекачване</label><button class="button full" type="submit">Намери пътуване →</button></form>${calendarNote(p.date)}<div class="note">Търсим тръгване в следващите 3 часа и до 1 час изчакване при прекачване. Оставяме поне 3 минути за смяната, плюс време за ходене. Пешеходната връзка е приблизителна — провери пресичанията на място.</div><div id="journey-results">${renderJourneyResults()}</div>`;
}
function renderJourneyResults() {
  if(!S.journeySearched)return '';
  if(!S.journeyResults.length)return empty('Не открихме подходящо пътуване','Промени часа, избери близка спирка или позволи прекачване. Търсенето зависи от публикуваните данни.');
  return `<div class="section-label">Варианти по най-ранно пристигане</div>${S.journeyResults.map((j,index)=>`<article class="journey-card ${S.selectedJourney===index?'selected':''}"><div class="journey-top"><strong>${C.clock(j.depart)} → ${C.clock(j.arrive)}${j.arrive>=C.DAY?' +1':''}</strong><small>${Math.round((j.arrive-j.depart)/60)} мин</small></div><div class="journey-legs">${j.legs.map((l,i)=>`${i?'<span>→</span>':''}${badge(l.route,true)}`).join('')}<small>· ${j.legs.length===1?'директно':'1 прекачване'}</small></div>${j.legs.map((l,i)=>`${i?`<div class="walk">${j.walk?.metres?'Пеша ~'+j.walk.metres+' м · ':''}Връзка: ${Math.round((l.depart-j.legs[i-1].arrive)/60)} мин общо</div>`:''}<div class="journey-leg"><strong>Линия ${E(routeName(l.route))} към ${E(pattern(l.pattern).head)}</strong><p>${C.clock(l.depart)} · ${E(stop(l.from)?.name)}<br>${C.clock(l.arrive)} · ${E(stop(l.to)?.name)}</p></div>`).join('')}<button class="button secondary full" data-journey="${index}">Покажи схемата на картата</button></article>`).join('')}`;
}
function rememberForm() {
  if($('journey-from')) {const p=S.planner;p.from=readStopInput($('journey-from').value);p.to=readStopInput($('journey-to').value);p.date=$('journey-date').value||C.now().date;p.time=$('journey-time').value||C.now().text;p.transfers=$('journey-transfers').checked;p.walk=$('journey-walk').checked;}
}
function switchTab(tab) {
  rememberForm();S.tab=tab;S.view={kind:'home'};$('search').value='';S.selectedRoute=null;S.pattern=null;S.follow=null;S.choosingPoint=false;
  if(tab!=='journey')S.journeyLayer?.clearLayers();
  else if(S.selectedJourney>=0)drawJourney(S.selectedJourney,false);
  drawRoute();redrawStops();renderVehicles();render();expandPanel();setHash();
}
function selectRoute(id, pid) {
  const r=route(id);if(!r)return;
  S.tab='routes';S.view={kind:'route',id};S.selectedRoute=id;S.pattern=r.patterns.includes(pid)?pid:r.patterns[0];S.follow=null;S.routeDate=C.now().date;S.journeyLayer.clearLayers();$('search').value='';
  drawRoute(true);redrawStops();renderVehicles();render();expandPanel();setHash();$('panel-content').scrollTop=0;
}
function selectStop(id) {
  const s=stop(id);if(!s)return;
  S.view={kind:'stop',id};S.tab='routes';S.stopDate=C.now().date;S.stopTime=null;S.fullDay=false;S.stopRoute=s.routes.includes(S.selectedRoute)?S.selectedRoute:'';S.follow=null;$('search').value='';
  if(!S.stopRoute){S.selectedRoute=null;S.pattern=null;drawRoute();}
  S.journeyLayer.clearLayers();redrawStops();renderVehicles();render();expandPanel();S.map.setView([s.lat,s.lon],Math.max(S.map.getZoom(),15));setHash();$('panel-content').scrollTop=0;
}
function selectTrip(id,date,index=0) {
  const t=S.core.trips.get(id);if(!t)return;
  S.view={kind:'trip',id,date,index};S.selectedRoute=t.route;S.pattern=t.pattern;S.follow=null;S.journeyLayer.clearLayers();$('search').value='';drawRoute(true);redrawStops();renderVehicles();render();expandPanel();setHash();$('panel-content').scrollTop=0;
}
function selectVehicle(id) {
  S.view={kind:'vehicle',id};S.tab='live';$('search').value='';const v=vehicle(id);S.pendingVehicle=v?null:id;
  if(v){S.selectedRoute=route(v.route)?v.route:null;S.pattern=null;drawRoute();S.map.setView([v.lat,v.lon],Math.max(S.map.getZoom(),15));}
  S.journeyLayer.clearLayers();redrawStops();renderVehicles();render();expandPanel();setHash();$('panel-content').scrollTop=0;
}
function renderSummary() {
  if(!S.data)return;
  let title='Стара Загора',sub=`${S.data.routes.length} линии · ${S.data.stops.length} спирки`;
  if(S.selectedRoute){title='Линия '+routeName(S.selectedRoute);sub=S.pattern?pattern(S.pattern).head:'GPS позиции и маршрути';}
  if(S.view.kind==='stop'){title=stop(S.view.id)?.name||title;sub='Спирка · часовете са по разписание';}
  if(S.tab==='journey'&&S.selectedJourney>=0){title='Схема на пътуването';sub='Свързани спирки; линиите не следват точно улиците';}
  if(S.choosingPoint){title='Избери точка от картата';sub='Натисни място, за да намериш близките спирки';}
  $('map-summary').innerHTML=`<strong>${E(title)}</strong><small>${E(sub)}</small>`;
  $('follow-bar').hidden=!S.follow;$('follow-label').textContent=S.follow?'· '+(vehicle(S.follow)?.label||S.follow):'';
}
function initMap() {
  if(!window.L)throw Error('Leaflet не е зареден. Качи всички файлове от архива.');
  S.map=L.map('map',{zoomControl:false,preferCanvas:true}).setView([42.425,25.633],13);
  L.control.zoom({position:'topright'}).addTo(S.map);
  S.tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(S.map);
  S.tiles.on('tileerror',()=>{if(++S.tileErrors===4)toast('Част от картните плочки не се заредиха. Линиите и разписанията остават достъпни.');});
  S.allLines=L.layerGroup();S.routeLayer=L.layerGroup().addTo(S.map);S.stopsLayer=L.layerGroup().addTo(S.map);S.journeyLayer=L.layerGroup().addTo(S.map);S.vehiclesLayer=L.layerGroup().addTo(S.map);S.locationLayer=L.layerGroup().addTo(S.map);
  for(const s of S.data.stops){const m=L.circleMarker([s.lat,s.lon],{radius:4,weight:1.7,color:'#527867',fillColor:'#fff',fillOpacity:1}).bindTooltip(E(s.name),{direction:'top'});m.on('click',()=>selectStop(s.id));S.stopMarkers.set(s.id,m);}
  S.map.on('click',e=>{if(S.choosingPoint){S.choosingPoint=false;setNearby(e.latlng.lat,e.latlng.lng,'map');}});
  S.map.on('dragstart',()=>{if(S.follow){S.follow=null;renderSummary();if(S.view.kind==='vehicle')render();}});
  S.map.on('zoomend',redrawStops);
  new ResizeObserver(()=>S.map.invalidateSize()).observe($('map-pane'));
  applySettings();redrawStops();
}
function drawRoute(fit=false) {
  if(!S.routeLayer)return;S.routeLayer.clearLayers();
  const r=route(S.selectedRoute);if(!r)return;
  const ids=S.pattern?[S.pattern]:r.patterns,drawn=new Set(),points=[];
  for(const pid of ids){const p=pattern(pid);if(!p)continue;const key=p.shape||pid;if(drawn.has(key))continue;drawn.add(key);const shape=S.data.shapes[p.shape];const path=shape?.length?shape:p.stops.map(stop).filter(Boolean).map(s=>[s.lat,s.lon]);if(!path.length)continue;points.push(...path);L.polyline(path,{color:'#fff',weight:7,opacity:.9,interactive:false}).addTo(S.routeLayer);L.polyline(path,{color:color(r.id),weight:4,opacity:.9,dashArray:shape?null:'6 5',interactive:false}).addTo(S.routeLayer);}
  if(fit&&points.length)S.map.fitBounds(points,{padding:[45,65],maxZoom:15});
}
function redrawStops() {
  if(!S.map)return;
  const selected=S.view.kind==='stop'?S.view.id:null,ids=S.pattern?new Set(pattern(S.pattern)?.stops):null;
  for(const s of S.data.stops){const m=S.stopMarkers.get(s.id),visible=s.id===selected||(settings.showStops&&(ids?ids.has(s.id):(!S.selectedRoute||s.routes.includes(S.selectedRoute))));if(visible&&!S.stopsLayer.hasLayer(m))S.stopsLayer.addLayer(m);else if(!visible&&S.stopsLayer.hasLayer(m))S.stopsLayer.removeLayer(m);if(visible)m.setStyle({radius:s.id===selected?8:(S.map.getZoom()<13?3:4.5),color:s.id===selected?'#173e31':'#527867',fillColor:s.id===selected?'#d5ef88':'#fff',weight:s.id===selected?3:1.7});}
}
function drawAllLines() {
  S.allLines.clearLayers();if(!settings.showLines){S.map.removeLayer(S.allLines);return;}
  const seen=new Set();for(const p of Object.values(S.data.patterns)){if(seen.has(p.shape)||!S.data.shapes[p.shape])continue;seen.add(p.shape);L.polyline(S.data.shapes[p.shape],{color:color(p.route),weight:2,opacity:.3,interactive:false}).addTo(S.allLines);}S.allLines.addTo(S.map);
}
function vehicleIcon(v) {
  const bearing=Number.isFinite(v.bearing)?`<i class="bearing" style="--bearing:${v.bearing}deg"></i>`:'';
  return L.divIcon({html:`<span class="vehicle-pin ${route(v.route)?.type===11?'trolley':''} ${S.view.kind==='vehicle'&&S.view.id===v.id?'selected':''}">${E(routeName(v.route)||'?')}${bearing}</span>`,className:'bus-icon',iconSize:[37,31],iconAnchor:[18,16]});
}
function renderVehicles() {
  if(!S.map)return;
  const ids=new Set();
  for(const v of S.vehicleData.vehicles){if(!settings.showVehicles||(S.selectedRoute&&v.route!==S.selectedRoute)||(S.tab==='live'&&S.view.kind==='home'&&S.liveRoute&&v.route!==S.liveRoute))continue;ids.add(v.id);let m=S.vehicleMarkers.get(v.id);if(!m){m=L.marker([v.lat,v.lon],{icon:vehicleIcon(v),keyboard:true,title:`Линия ${routeName(v.route)} · ${v.label||v.id}`});m.on('click',()=>selectVehicle(v.id));m.addTo(S.vehiclesLayer);S.vehicleMarkers.set(v.id,m);}else{m.setLatLng([v.lat,v.lon]);m.setIcon(vehicleIcon(v));}}
  for(const [id,m] of S.vehicleMarkers){if(!ids.has(id)){S.vehiclesLayer.removeLayer(m);S.vehicleMarkers.delete(id);}}
  if(S.follow){const v=vehicle(S.follow);if(v)S.map.panTo([v.lat,v.lon],{animate:false});else{S.follow=null;toast('Проследяването спря: няма актуална GPS позиция.');}}
  renderSummary();
}
function updateStatus() {
  const d=S.vehicleData,isLive=d.status==='live'&&d.vehicles.length>0;
  $('live-status').className='pill'+(isLive?' live':'');$('live-status').innerHTML=`<span class="status-dot"></span><span>${isLive?d.vehicles.length+' на живо':'Без GPS данни'}</span>`;
  $('feed-notice').className='feed-notice'+(isLive?'':' error');
  $('feed-notice').textContent=isLive?`${d.vehicles.length} актуални позиции · ${settings.autoRefresh?'проверка на '+GPS_REFRESH_SECONDS+' сек':'автоматичното обновяване е спряно'}`:(d.message||'GPS потокът е недостъпен.');
}
async function refreshVehicles(manual=false) {
  if(S.loadingGPS)return;S.loadingGPS=true;
  try{const response=await fetch('./api/vehicles',{cache:'no-store',signal:AbortSignal.timeout(18000)});if(!response.ok)throw Error('HTTP '+response.status);const data=await response.json();if(!Array.isArray(data.vehicles))throw Error('Invalid feed');const now=Date.now()/1000;data.vehicles=data.vehicles.filter(v=>typeof v.id==='string'&&Number.isFinite(v.lat)&&Number.isFinite(v.lon)&&Number.isFinite(v.time)&&Math.abs(now-v.time)<=180);S.vehicleData=data;if(manual)toast(data.vehicles.length?`Получени са ${data.vehicles.length} актуални позиции.`:(data.message||'Няма актуални позиции.'));}
  catch{S.vehicleData={status:'error',message:'Няма връзка с GPS потока. Опитваме отново при следващото обновяване.',vehicles:[],updated:null};if(manual)toast('GPS данните не можаха да се обновят.');}
  finally{S.loadingGPS=false;if(S.view.kind==='vehicle'&&S.pendingVehicle===S.view.id&&vehicle(S.pendingVehicle))selectVehicle(S.pendingVehicle);updateStatus();renderVehicles();if(S.view.kind==='vehicle'||(S.view.kind==='home'&&['live','routes'].includes(S.tab)))render();}
}
function setNearby(lat,lon,source,accuracy) {
  S.nearby={lat,lon,source};S.tab='nearby';S.view={kind:'home'};S.selectedRoute=null;S.pattern=null;S.follow=null;$('search').value='';S.locationLayer.clearLayers();S.journeyLayer.clearLayers();
  if(accuracy)L.circle([lat,lon],{radius:Math.min(accuracy,5000),color:'#3989ac',weight:1,fillOpacity:.07,interactive:false}).addTo(S.locationLayer);
  L.circleMarker([lat,lon],{radius:8,color:'#fff',weight:3,fillColor:'#348cc0',fillOpacity:1}).addTo(S.locationLayer);
  S.map.setView([lat,lon],15);drawRoute();redrawStops();renderVehicles();render();expandPanel();setHash();
}
function locate() {
  if(!window.isSecureContext){switchTab('nearby');toast('Геолокацията изисква HTTPS. Използвай „Избери от карта“.');return;}
  if(!navigator.geolocation){toast('Този браузър няма геолокация. Избери точка от картата.');return;}
  toast('Търсене на местоположението…');navigator.geolocation.getCurrentPosition(p=>setNearby(p.coords.latitude,p.coords.longitude,'gps',p.coords.accuracy),()=>toast('Местоположението не е достъпно. Можеш да избереш точка от картата.'),{enableHighAccuracy:false,timeout:12000,maximumAge:60000});
}
function drawJourney(index, fit=true) {
  const j=S.journeyResults[index];if(!j)return;S.selectedJourney=index;S.selectedRoute=null;S.pattern=null;S.routeLayer.clearLayers();S.journeyLayer.clearLayers();const points=[];
  for(const leg of j.legs){const t=S.core.trips.get(leg.trip),path=t.times.slice(leg.fromIndex,leg.toIndex+1).map(p=>stop(p[0])).map(s=>[s.lat,s.lon]);points.push(...path);L.polyline(path,{color:color(leg.route),weight:5,opacity:.9,dashArray:'9 5',interactive:false}).addTo(S.journeyLayer);for(const [sid,label] of [[leg.from,'Качване'],[leg.to,'Слизане']]){const s=stop(sid);L.circleMarker([s.lat,s.lon],{radius:7,color:color(leg.route),fillColor:'#fff',fillOpacity:1,weight:3}).bindTooltip(`${label}: ${E(s.name)}`).addTo(S.journeyLayer);}}
  if(j.walk?.metres){const a=stop(j.walk.from),b=stop(j.walk.to);L.polyline([[a.lat,a.lon],[b.lat,b.lon]],{color:'#a37732',weight:3,dashArray:'3 6'}).addTo(S.journeyLayer);}
  if(fit&&points.length)S.map.fitBounds(points,{padding:[50,70],maxZoom:15});redrawStops();renderVehicles();renderSummary();
}
function applySettings() {
  const dark=settings.theme==='dark'||(settings.theme==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.dataset.theme=dark?'dark':'light';document.body.classList.toggle('map-soft',settings.mapStyle==='soft');
  $('theme').value=settings.theme;$('map-style').value=settings.mapStyle;
  for(const [id,key] of [['show-stops','showStops'],['show-vehicles','showVehicles'],['show-lines','showLines'],['auto-refresh','autoRefresh']])$(id).checked=Boolean(settings[key]);
  if(S.map){drawAllLines();redrawStops();renderVehicles();updateStatus();}storage.set('settings',settings);
}
function showInfo() {
  if(S.data){$('data-info').innerHTML=`<strong>${S.data.routes.length} линии · ${S.data.stops.length} спирки · ${S.data.trips.length} курса</strong><br>Версия на разписанието: ${E(S.data.feed_version||'неизвестна')}<br>Валидност до: ${E(S.data.feed_end?S.data.feed_end.slice(6,8)+'.'+S.data.feed_end.slice(4,6)+'.'+S.data.feed_end.slice(0,4):'неуказана')}<br><a href="https://livetransport.eu" target="_blank" rel="noopener">Разписания: LiveTransport / CC BY 4.0</a><br><a href="https://sipbg.gov.bg/bgnap/portal/bg/catalog/85eead1a-9046-4331-8655-7918bfe7c36d" target="_blank" rel="noopener">GPS: Национална точка за достъп</a><br><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">Картни данни: OpenStreetMap</a>`;}$('settings-dialog').showModal();
}
function setHash() {
  const p=new URLSearchParams();const v=S.view;
  if(v.kind==='route'){p.set('route',v.id);if(S.pattern)p.set('pattern',S.pattern);}
  else if(v.kind==='stop'){p.set('stop',v.id);if(S.selectedRoute)p.set('route',S.selectedRoute);}
  else if(v.kind==='vehicle')p.set('vehicle',v.id);
  else if(v.kind==='trip'){p.set('trip',v.id);p.set('date',v.date);}
  else if(S.tab!=='routes')p.set('tab',S.tab);
  history.replaceState(null,'',location.pathname+location.search+(p.size?'#'+p.toString():''));
}
function readHash() {
  const p=new URLSearchParams(location.hash.slice(1));
  if(p.has('stop')&&stop(p.get('stop'))){S.selectedRoute=route(p.get('route'))?.id||null;selectStop(p.get('stop'));}
  else if(p.has('route')&&route(p.get('route')))selectRoute(p.get('route'),p.get('pattern'));
  else if(p.has('trip')&&S.core.trips.has(p.get('trip'))){let date=p.get('date');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date)))date=C.now().date;selectTrip(p.get('trip'),date);}
  else if(p.has('vehicle'))selectVehicle(p.get('vehicle'));
  else if(['routes','journey','nearby','favorites','live'].includes(p.get('tab')))switchTab(p.get('tab'));
}
function expandPanel(){document.querySelector('.workspace').classList.remove('map-expanded');$('sheet-toggle').setAttribute('aria-expanded','true');$('mobile-open').hidden=true;}
function collapsePanel(){document.querySelector('.workspace').classList.add('map-expanded');$('sheet-toggle').setAttribute('aria-expanded','false');$('mobile-open').hidden=false;}
function bindEvents() {
  $('search').addEventListener('input',()=>{render();expandPanel();});
  $('panel-content').addEventListener('submit',async event=>{
    if(event.target.id!=='journey-form')return;event.preventDefault();rememberForm();const p=S.planner;
    if(!p.from||!p.to){toast('Избери точните спирки от предложенията под полетата.');return;}
    if(p.from===p.to){toast('Началната и крайната спирка трябва да са различни.');return;}
    const submit=event.target.querySelector('[type=submit]');submit.disabled=true;submit.textContent='Търсене…';
    await new Promise(resolve=>setTimeout(resolve,30));
    try{const [h,m]=p.time.split(':').map(Number);S.journeyResults=S.core.plan(p.from,p.to,p.date,h*3600+m*60,{transfers:p.transfers,walk:p.walk});S.journeySearched=true;S.selectedJourney=-1;S.journeyLayer.clearLayers();render();if(S.journeyResults.length){drawJourney(0);$('journey-results').innerHTML=renderJourneyResults();$('journey-results').scrollIntoView({block:'nearest',behavior:'smooth'});}}catch{toast('Неуспешно търсене. Провери датата и спирките.');submit.disabled=false;submit.textContent='Намери пътуване →';}
  });
  document.addEventListener('click',event=>{
    const b=event.target.closest('button');if(!b)return;
    if(b.dataset.closeDialog){$(b.dataset.closeDialog).close();return;}
    if(!S.data)return;
    if(b.dataset.tab){switchTab(b.dataset.tab);return;}
    if(b.dataset.favorite){const list=favorites[b.dataset.favorite];list.has(b.dataset.id)?list.delete(b.dataset.id):list.add(b.dataset.id);const saved=storage.set('favorites',{routes:[...favorites.routes],stops:[...favorites.stops]});render();if(!saved)toast('Браузърът не разрешава постоянно запазване. Любимите ще останат само до презареждане.');return;}
    if(b.dataset.route){selectRoute(b.dataset.route);return;}
    if(b.dataset.stop){selectStop(b.dataset.stop);return;}
    if(b.dataset.trip){selectTrip(b.dataset.trip,b.dataset.date,Number(b.dataset.index));return;}
    if(b.dataset.vehicle){selectVehicle(b.dataset.vehicle);return;}
    if(b.dataset.type){S.type=b.dataset.type;render();return;}
    if(b.dataset.liveRoute){S.liveRoute=b.dataset.liveRoute;switchTab('live');return;}
    if(b.dataset.planFrom||b.dataset.planTo){rememberForm();if(b.dataset.planFrom)S.planner.from=b.dataset.planFrom;if(b.dataset.planTo)S.planner.to=b.dataset.planTo;S.journeyResults=[];S.journeySearched=false;S.selectedJourney=-1;switchTab('journey');return;}
    if(b.dataset.follow){S.follow=S.follow===b.dataset.follow?null:b.dataset.follow;settings.showVehicles=true;renderVehicles();render();return;}
    if(b.dataset.journey!=null){drawJourney(Number(b.dataset.journey));$('journey-results').innerHTML=renderJourneyResults();return;}
    const action=b.dataset.action;
    if(action==='back')switchTab(S.tab);
    else if(action==='info')showInfo();
    else if(action==='refresh')refreshVehicles(true);
    else if(action==='share'){setHash();$('share-url').value=location.href;$('share-dialog').showModal();}
    else if(action==='print')window.print();
    else if(action==='all-departures'){S.fullDay=true;render();}
    else if(action==='next-departures'){S.fullDay=false;render();}
    else if(action==='departures-now'){S.fullDay=false;S.stopDate=C.now().date;S.stopTime=null;render();}
    else if(action==='locate')locate();
    else if(action==='pick-point'){S.choosingPoint=!S.choosingPoint;render();}
    else if(action==='swap'){rememberForm();[S.planner.from,S.planner.to]=[S.planner.to,S.planner.from];S.journeyResults=[];S.journeySearched=false;S.selectedJourney=-1;S.journeyLayer.clearLayers();render();}
  });
  document.addEventListener('change',event=>{const x=event.target;
    if(x.id==='route-pattern'){S.pattern=x.value;drawRoute(true);redrawStops();render();setHash();}
    else if(x.id==='route-date'){S.routeDate=x.value||C.now().date;render();}
    else if(x.id==='stop-date'){S.stopDate=x.value||C.now().date;S.stopTime=null;render();}
    else if(x.id==='stop-time'){S.stopTime=x.value||null;render();}
    else if(x.id==='stop-route'){S.stopRoute=x.value;S.selectedRoute=x.value||null;S.pattern=null;drawRoute();redrawStops();renderVehicles();render();setHash();}
    else if(x.id==='live-route'){S.liveRoute=x.value;renderVehicles();render();}
    else if(x.id==='theme'){settings.theme=x.value;applySettings();}
    else if(x.id==='map-style'){settings.mapStyle=x.value;applySettings();}
    else {const key={'show-stops':'showStops','show-vehicles':'showVehicles','show-lines':'showLines','auto-refresh':'autoRefresh'}[x.id];if(key){settings[key]=x.checked;applySettings();if(key==='autoRefresh'&&x.checked)refreshVehicles();}}
  });
  $('home').onclick=()=>{switchTab('routes');S.map.setView([42.425,25.633],13);};$('live-status').onclick=()=>switchTab('live');
  $('settings-open').onclick=showInfo;$('layers-open').onclick=showInfo;$('locate').onclick=locate;
  $('map-reset').onclick=()=>{S.follow=null;S.map.setView([42.425,25.633],13);renderSummary();};
  $('refresh-now').onclick=()=>refreshVehicles(true);$('follow-bar').onclick=()=>{S.follow=null;renderSummary();if(S.view.kind==='vehicle')render();};
  $('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else toast('Този браузър не поддържа цял екран.');}catch{toast('Цял екран не е достъпен в този браузър.');}};
  $('sheet-toggle').onclick=collapsePanel;$('mobile-open').onclick=expandPanel;
  $('copy-link').onclick=async()=>{try{await navigator.clipboard.writeText($('share-url').value);toast('Линкът е копиран.');}catch{$('share-url').focus();$('share-url').select();toast('Натисни Ctrl+C или задръж върху маркирания линк, за да го копираш.');}};
  document.addEventListener('keydown',event=>{const editing=/INPUT|TEXTAREA|SELECT/.test(event.target.tagName);if(event.key==='/'&&!editing&&!document.querySelector('dialog[open]')){event.preventDefault();expandPanel();$('search').focus();}if(event.key==='Escape'&&!document.querySelector('dialog[open]')){S.choosingPoint=false;S.follow=null;if($('search').value){$('search').value='';render();}renderSummary();}});
  window.addEventListener('hashchange',readHash);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&settings.autoRefresh)refreshVehicles();});
  window.addEventListener('online',()=>{if(settings.autoRefresh)refreshVehicles();});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(settings.theme==='auto')applySettings();});
}
function tick() {
  const now=C.now();$('clock').textContent=`${now.text} · ${metaDate(now.date)}`;
  if(!S.data)return;
  const before=S.vehicleData.vehicles.length;S.vehicleData.vehicles=S.vehicleData.vehicles.filter(v=>Math.abs(Date.now()/1000-v.time)<=180);
  if(before!==S.vehicleData.vehicles.length){if(!S.vehicleData.vehicles.length)S.vehicleData.status='empty';updateStatus();renderVehicles();if(S.view.kind==='vehicle'||(S.tab==='live'&&S.view.kind==='home'))render();}
  if($('stop-departures')&&S.view.kind==='stop'&&!S.stopTime&&!S.fullDay&&S.stopDate===now.date&&document.activeElement?.tagName!=='INPUT'&&document.activeElement?.tagName!=='SELECT'){$('stop-departures').innerHTML=departureRows(S.core.departures(S.view.id,now.date,now.seconds,{route:S.stopRoute||null,horizon:4*3600,limit:16}),now.date);}
}
async function start() {
  tick();setInterval(tick,15000);
  try{const response=await fetch('./network.json?v=2');if(!response.ok)throw Error('Разписанията не могат да се изтеглят.');S.data=await response.json();if(S.data.schema!==2)throw Error('Нужен е обновеният network.json. Изпълни отново deploy.sh от новия архив.');S.data.routes.sort((a,b)=>a.name.localeCompare(b.name,'bg',{numeric:true}));S.core=C.create(S.data);S.data.stops.sort((a,b)=>a.name.localeCompare(b.name,'bg'));initMap();bindEvents();render();readHash();await refreshVehicles();setInterval(()=>{if(settings.autoRefresh&&!document.hidden)refreshVehicles();},GPS_REFRESH_SECONDS*1000);if(expiry(C.now().date))toast('Разписанието е с изтекъл срок. Нужна е актуализация на данните.');}
  catch(error){$('panel-content').innerHTML=empty('Неуспешно зареждане',error.message);$('map-summary').textContent='Картата не е заредена';$('feed-notice').textContent='Провери инсталацията и връзката.';console.error(error);}
}
start();
