# Audit a stav implementace (9. listopadu 2026)

Toto není potvrzení splnění celého implementačního zadání. Nové změny zatím
nebyly nasazeny do produkčního add-onu ani ověřeny proti jeho Recorderu.

## Ověřený výchozí stav

- Repozitář obsahuje HAOS add-on 0.4.1, nikoliv HA Custom Integration.
- Přihlášení: Playwright/Chromium, CAS formulář, soukromá browser session v
  `/data/browser-state.json`, jeden pokus o obnovu čisté session. Neměníme je.
- Získávání: první datové okno PND, volba období, vyčkání XHR/fetch, CSV export
  dekódovaný jako Windows-1250. Parser zná jen `Datum`, `+A/<ELM> [kW]`, `Status`.
  Z naměřené čtvrthodinové průměrné hodnoty kW počítá kWh jako kW / 4.
- Backfill: od explicitního data nebo po posledním úspěšném dni, připraví celý
  rozsah a přehraje navazující kumulativní sumy. Neúplný den blokuje celý rozsah.
  Původně chyběl archiv jednotlivých měření a checkpoint získávání jednotlivých dní.
- Původní perzistence: atomicky přejmenovaný JSON `/data/state.json`, přihlašovací
  stav a screenshot poslední chyby. Naměřené hodnoty byly pouze v HA Recorderu.
- HA transport: Supervisor token, `recorder/import_statistics` přes WebSocket,
  externí ID `cez_pnd:consumption_<ELM>`. Neexistují vlastní entity ani Config Flow.
- Instalace: privátní repozitář add-onu, Docker image Playwright Noble, `npm ci`,
  Node >=24 dle package.json. Lokální Node je 22.23.2 a Python 3.15.0; to nejsou
  verze produkčního kontejneru. Produkční Python zatím nebyl zjištěn.
- Živé HA před aktualizací: Core 2026.10.4, Supervisor 2026.10.5, HAOS 18.3,
  Frontend 20260930.5. Add-on 0.4.1 běží. Logy potvrzují import 1.–8. 11. 2026.
- Nativní Energy Dashboard obsahuje jeden PND grid zdroj a zobrazuje pro
  8. 11. 2026 celkem 51,35 kWh. Zobrazených 0 Kč není ověřená skutečná cena.
- Produkční log obsahuje i neúplný export 20. 8. 2026 (89/96 naměřených intervalů,
  zbytek výpadek/neplatná data). Takový den nesmí být doplněn smyšlenými nulami.
- Původní fixtures byly syntetické. Živý portál 2.6.1 následně potvrdil sestavu
  **17 Registry za den (+E, -E)**, nikoli měsíční registry uvedené v zadání.
  Poskytuje `+E`, `-E`, `+E_NT`, `+E_VT` v kWh na konci místního dne (24:00).
  Označení OBIS 1.8.0/1.8.1/1.8.2 export výslovně neobsahuje.
  V rychlé sestavě není nabízena sestava 18; její dostupnost jinde nebyla prokázána.
  Export má opakované trojice Datum/hodnota/Status a americké oddělovače
  tisíců a desetinných míst (`2,288.142`). DOM používá české formátování.
  Naměřený export byl stažen do uživatelských Downloads, do repa patří pouze
  anonymizované kontrolní hodnoty v `test/registers.test.js`.
- Odečty 7./8. listopadu dávají spotřebu 8. listopadu VT 5,160 kWh,
  NT 46,186 kWh a celkem 51,346 kWh. Sestava 07 pro tentýž den uvádí
  rovněž 51,346 kWh; HA zobrazuje zaokrouhlených 51,35 kWh.
  V průběhu 9. listopadu má sestava 07 pro aktuální den částečných 0,785 kWh,
  budoucí dny 0,0, zatímco registry budoucích dnů mají pomlčky. Nuly
  budoucích dnů se proto nikdy nesmějí importovat jako dokončená měření.
  Nejstarší dostupná historie ani přesná publikační frekvence nejsou ověřeny.

## Zvolené rozšíření existujícího transportu

`history.js` ukládá validovaná původní i normalizovaná měření do soukromého
`/data/history/<hash-odběrného-místa>/<datum>.json`. UTC intervaly mají fyzický
měřič, energii, neznámý tarif (null), zdroj, kvalitu, úplnost a čas získání.
Denní upsert má obsahový hash a revizi; nemění se jen kvůli novému času získání.
Změny se zaznamenávají revizí, předchozí verze jednotlivých měření se nearchivují.
`pending-plan.json` umožňuje navázat získávání stejného přerušeného rozsahu bez
opakovaného přihlášení a exportu již dokončených dní. Dokončený backfill se při
novém explicitním požadavku načítá z PND znovu.

Běžný provoz znovu kontroluje posledních 7 již importovaných dní (nastavitelné
`correction_days`, 0–90). Reimportuje i navazující hodiny, aby oprava nezpůsobila
skok kumulativní sumy. Připravený rozsah se zatím stále zapisuje jedním HA
požadavkem, nikoli Recorderem potvrzovanými dávkami. Exponenciální retry má strop
6 hodin. Souběh je blokován pro stejný objekt úložiště v jednom procesu;
neposkytuje distribuovaný zámek mezi dvěma instancemi add-onu.

`pricing.js` je samostatný cenový model, dosud nepřipojený k produkčnímu importu.
Výchozí potvrzené ceny platí konzervativně jen 1. 10.–31. 12. 2026. Neznámé ceny
2025/2027 se nepřebírají. Desetinné částky používají interně BigInt v miliardtinách
Kč. Fixní měsíční částka se rozdělí nejprve podle kalendářních dní a poté podle
23/24/25 hodin dne; rozdíly celočíselných hranic zachovají přesných 842 Kč/měsíc.
Celkové náklady zůstávají null, pokud není známý tarif nebo chybí měření.
Tento modul sám nevytváří nákladové statistiky ani cenové entity.
`registers.js` parsuje skutečně ověřený formát a odvozuje denní VT/NT pouze
z navazujících odečtů stejného elektroměru. Rozpozná výměnu, reset, chybějící
registry a nesoulad s profilem. `priceDailyTariffs` oceňuje denní součty bez
vymyšleného hodinového rozložení. `scrapeRegistersDate` používá stávající
přihlašování a po čtení vrací okno do sestavy 01. Pravidelný scheduler tuto
metodu ještě nevolá.

## Energy preferences a návrat

Automatická konfigurace dál používá jeden unified grid zdroj s celkovou energií.
Volitelný `stat_cost` je připraven ve funkci vytvářející zdroj, ale zatím se
nepředává z importu. VT/NT se nevytvářejí bez doložených vstupních měření.

Před novým zápisem se uloží úplné původní preferences a vlastněný nový zdroj
v `/data/energy-backup.json`. Cizí grid import vyvolá konflikt namísto potenciálního
zdvojení spotřeby; existující vlastní ID je rozpoznáno i ve starším flow_from.
Po novém zápisu se kontroluje `energy/validate`; při chybě se odstraní pouze
přidaný zdroj. Žádný přímý zápis do `.storage/energy` ani databáze Recorderu.

Pro ruční návrat: zastavit scheduler, nastavit `add_to_energy_dashboard: false`,
v prostředí add-onu spustit `node /app/src/rollback.js` se stejnými Supervisor
credentials. Skript odstraní pouze nezměněný zdroj doložený zálohou a zachová
mezitím přidané cizí zdroje. Pokud byl zdroj uživatelem upraven, odmítne jej
smazat. Původní již existující zdroj bez zálohy není automaticky odstraňován.
Statistiky a archiv zůstávají zachovány. Tento rollback je ověřen lokálními testy,
ne produkčním přepnutím.

## Další nutné etapy

1. Rozšířit ověření PND na historii, výměnu měřiče a případné další sestavy;
   denní registry a konec dne již byly ověřeny.
2. Zvolit transport do HA Core s ohledem na nutnost browser runtime; HA Core
   standardně nemá Node ani Chromium. Nevkládat neověřený přepis CAS přihlášení.
3. Implementovat nativní Python adaptér, Config/Options/Reauth Flow, zařízení,
   diagnostické entity, Repairs a služby backfill/reprice/rollback.
4. Propojit doložená tarifní data s cenovým modelem a importovat externí energetické
   a peněžní statistiky přes `async_add_external_statistics` jako jediný zapisovač.
5. Vyřešit stabilní identitu odběrného místa při výměně elektroměru; dosavadní
   import výměnu odmítá, místo aby smísil nesouvisející registry.
6. Doplnit ověřování každé dávky přes Recorder API, detekci ztracených statistik,
   skutečné ceny nastavitelné z UI a nedestruktivní migraci existujícího ID.
7. Ověřit všech 15 scénářů zadání na skutečném HA včetně migrace, restartu,
   historických oprav, odinstalace a návratu. Lokální syntetické testy nejsou
   náhradou těchto integračních testů.

## Technické reference

Přečtené zdroje Core (2026.11.0):
- https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/opower/coordinator.py
- https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/energy/data.py
- https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/energy/websocket_api.py
- https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/recorder/statistics.py

Unified grid schéma a `stat_cost` byly navíc porovnány s `energy/data.py` ve
verzi 2026.10.4. Přítomnost schématu `cost_adjustment_day` sama neprokazuje správné
historické vyúčtování fixních cen; nový cenový model se na tuto položku nespoléhá.

## Provedené systémové aktualizace a ověření

Na výslovný pokyn uživatele byl Core aktualizován z 2026.10.4 na **2026.11.0**.
Byla zapnuta automatická záloha před aktualizací; UI následně potvrdilo čerstvou
zálohu. HAOS byl aktualizován z 18.3 na **18.4** a byl proveden řízený restart
hostitele. Po návratu HA byly aktivní verze potvrzeny jak v About, tak v terminálu.
Supervisor zůstal 2026.10.5. Add-on 0.4.1 má po restartu stav `started`.
Energy Dashboard i po obou aktualizacích zobrazuje 8. listopadu 51,35 kWh.

Snímky ověření: `/tmp/cez-pnd-verification/ha-updated.jpg` a
`/tmp/cez-pnd-verification/energy-after-update.jpg` (dočasné lokální soubory,
nezahrnovat do veřejného repozitáře).

Lokální validace konečného pracovního stromu:
- `npm test`: 68 úspěšných testů, 6 browser scénářů standardně přeskočeno.
- `npm run test:browser`: všech 6 skutečných Chromium scénářů úspěšných.
- `npm run check`: syntaktická kontrola všech zdrojových JS souborů úspěšná.
- `git diff --check`: bez chyb whitespace.

Testy pokrývají původní scraping, opakovaný backfill a retry po nejednoznačném
potvrzení, DST, neúplná měření, opravu období, archiv/revize/restart checkpointu,
konkurenci, registry a reset/výměnu měřiče na úrovni modelu, skutečné kontrolní
hodnoty PND, ceny a fixní měsíční součty, ochranu cizích zdrojů a bezpečný rollback.
Nepokrývají dosud nativní Python integraci a její lifecycle, protože není vytvořena.
Nebylo provedeno nové produkční nahrání historie ani nasazení změněného add-onu.
