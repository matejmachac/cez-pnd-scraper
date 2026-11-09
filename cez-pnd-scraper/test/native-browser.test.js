import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DateTime } from 'luxon';
import { PndScraper } from '../src/scraper.js';
import { syntheticCsv } from './fixtures/pnd.js';

test('native monthly Chromium export includes opening registers, excludes today, and restores report 01',{
  skip:process.env.PND_BROWSER_TESTS!=='1',
},async(t)=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'pnd-native-browser-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const requests=[];
  const portal=createServer((request,response)=>{
    const url=new URL(request.url,'http://synthetic');
    if(url.pathname==='/data'){
      const from=DateTime.fromFormat(url.searchParams.get('from'),'dd.MM.yyyy',{zone:'Europe/Prague'});
      const to=DateTime.fromFormat(url.searchParams.get('to'),'dd.MM.yyyy',{zone:'Europe/Prague'});
      const registry=url.searchParams.get('report')==='17';
      requests.push({from:from.toISODate(),to:to.toISODate(),report:registry?'17':'01'});
      const rows=[registry?'"Datum";"+E/123 [kWh]";"Status";"Datum";"+E_NT/123 [kWh]";"Status";"Datum";"+E_VT/123 [kWh]";"Status"':syntheticCsv(from.toISODate()).split('\n')[0]];
      let index=1;
      for(let day=from;day<to;day=day.plus({days:1}),index++){
        if(registry){
          const stamp=day.toFormat('dd.MM.yyyy')+' 24:00:00';
          rows.push(`"${stamp}";${index*24};"namerena data OK";"${stamp}";${index*20};"namerena data OK";"${stamp}";${index*4};"namerena data OK"`);
        }else rows.push(...syntheticCsv(day.toISODate()).split('\n').slice(1));
      }
      response.writeHead(200,{'content-type':'text/plain'}).end(rows.join('\n'));
      return;
    }
    response.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(`
      <div class="pnd-window"><span>Všechny EANy</span>
      <input id="meter-intervalType"><div class="multiselect__option">Vlastní období</div>
      <input id="meter-interval" value="01.11.2026 - 02.11.2026"><button>Vyhledat data</button>
      <a id="profile" href="#">01 Profil spotřeby (+A)</a>
      <a id="register" href="#">17 Registry za den (+E, -E)</a><a id="csv" download="data.csv">CSV</a></div>
      <script>
        let report='01';
        const load=async()=>{
          const [from,to]=document.getElementById('meter-interval').value.split(' - ');
          const csv=await(await fetch('/data?report='+report+'&from='+from+'&to='+to)).text();
          document.getElementById('csv').href=URL.createObjectURL(new Blob([csv]));
        };
        document.querySelector('button').onclick=load;
        document.getElementById('profile').onclick=e=>{e.preventDefault();report='01';load();};
        document.getElementById('register').onclick=e=>{e.preventDefault();report='17';load();};
      </script>`);
  });
  await new Promise(resolve=>portal.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>portal.close(resolve)));
  const scraper=new PndScraper({dataDir,timezone:'Europe/Prague',writerMode:'native',elm:'',
    dashboardUrl:`http://127.0.0.1:${portal.address().port}/cezpnd2/external/dashboard/view`}, {info(){},warn(){}});
  const result=await scraper.scrapeMonth('2026-11',DateTime.fromISO('2026-11-09T10:00:00',{zone:'Europe/Prague'}));
  assert.equal(result.from,'2026-10-31');
  assert.equal(result.through,'2026-11-08');
  assert.equal(Object.keys(result.profiles).length,9);
  assert.equal(result.profiles['2026-11-08'].intervals.length,96);
  assert.equal(result.registers.length,27);
  assert.equal(result.incomplete.length,0);
  assert.deepEqual(requests.map(row=>row.report),['01','01','17','01']);
});
