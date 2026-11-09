# Nativní adaptér ČEZ PND 0.5.0

## Architektura

Původní Playwright/CAS přihlášení zůstává v existující HAOS aplikaci. HA Core
standardně neobsahuje Node.js ani Chromium, proto se browser runtime nepřesouvá
do procesu HA. Přibyla čistá nativní integrace `custom_components/cez_pnd`
bez dalších Python závislostí, MQTT nebo externího databázového serveru.

Aplikace má dva výlučné režimy:

- `legacy` (výchozí): původní samostatný plánovač a WebSocket import fungují dál.
- `native`: původní plánovač je vypnutý. Soukromé autentizované HTTP rozhraní
  poskytuje pouze měření; jediným zapisovačem Recorderu je nativní integrace.

Token transportu není heslem PND a neposkytuje přístup k HA API ani přihlašovacím
údajům. Port 8099 se nezveřejňuje do sítě. Diagnostický export obsahuje pouze
počty a stav, nikoliv tokeny, adresy, EAN, fyzická čísla měřičů nebo měření.

## Měření a historie

Transport umí získat měsíční export sestav 01 a 17 včetně otevíracího registru.
Každý dokončený den se ověřuje nezávisle (96/92/100 čtvrthodin), budoucí nuly a
částečný dnešek se nepřebírají. Při více fyzických měřičích zůstává jejich identita
u jednotlivých intervalů; současně aktivní překrývající se zdroje se odmítnou.

Archiv je uložen nativním HA Store po měsících. Zahrnuje UTC intervaly, původ
hodnot, kvalitu, úplnost, fyzický měřič, čas získání, obsahový hash a revizi.
Zdrojový čas opravy není v exportu znám a zůstává null. Nejde o novou databázi.

První běh začíná aktuálními dny a postupuje k nastavenému počátku, výchozí rozsah
je až tři roky. Neznamená to, že PND tři roky skutečně zpřístupňuje. Nepřítomné
nebo neúplné dny vyvolají Repairs. Následující běhy kontrolují sedm posledních dní
a omezený počet starých chybějících dní, nikoli celé tři roky znovu.

Checkpoint uchovává získané dny a dosud nepublikovaný rozsah. Po přerušení se
nezačne celá historie znovu. Změna staršího dne přepočítá navazující uloženou
historii bez opakovaného stahování všech pozdějších exportů. Recorder dostává
upserty přes `async_add_external_statistics`, nejvýše 744 hodin v dávce. Každá
dávka je před potvrzením checkpointu ověřena čtením `statistics_during_period`.
Neprovádějí se přímé zápisy do databáze Recorderu.

## Tarifní a cenové rozlišení

Na skutečném účtu byla ověřena sestava **17 Registry za den (+E, -E)** se sloupci
`+E`, `+E_NT`, `+E_VT` v kWh a denním odečtem ve 24:00 místního času. Sestava 07
poskytuje kontrolní denní spotřebu. Označení konkrétních OBIS registrů export
výslovně neuvádí. Sestava 18 není v ověřené rychlé sestavě nabízena.

Celková energie má skutečné hodinové rozlišení z profilu. VT/NT jsou **denní
odečty**: jejich statistiky obsahují denní snapshot v hodině končící odečtem.
Denní rozdíly se nerozdělují po hodinách. Native Energy má jediný grid zdroj
celkové energie; VT a NT se do energetického toku podruhé nepřičítají.

Variabilní náklady jsou přesně vypočtené z denních VT/NT rozdílů a zaúčtované u
denního odečtu. Hodinový graf nákladů proto není hodinově změřeným tarifním
profilem. Denní a měsíční součty nákladů jsou přesné pro úplná oceněná období.
Fixní náklady se účtují nezávisle na kWh: nejprve podle skutečného počtu dní v
měsíci a potom podle 23/24/25 hodin dne. Celý měsíc se sazbou 842 Kč dává přesně
842 Kč, i při nulové spotřebě. Nevyužívá se `cost_adjustment_day` jako náhrada.

Potvrzený výchozí ceník pokrývá konzervativně pouze 1. 10.–31. 12. 2026.
Pro rok 2025 ani pro neznámé regulované ceny 2027 se nic nepředpokládá.
Chybějící tarif nebo ceník se nevydává za nulové náklady; vyvolá Repairs a senzor
kvality. Ceníky lze upravit v nativním Options Flow, včetně intervalů platnosti,
a samostatnou akcí vědomě přepočítat historické období.

## Entity a statistiky

Zařízení obsahuje celkovou energii, VT, NT, celkové náklady, aktuální ceny VT/NT,
měsíční fixní sazbu a diagnostiku synchronizace, posledního měření, chybějících
dní a kvality tarifů/nákladů. Entity nemají `state_class`, aby Recorder paralelně
nekompiloval kopii externě importované historie.

Statistiku celkového odběru lze při migraci zachovat v původním ID
`cez_pnd:consumption_<ELM>`. Další integračně vlastněná ID jsou
`cez_pnd:<odběrné_místo>_import_vt`, `_import_nt`, `_cost_vt`, `_cost_nt`,
`_cost_fixed`, `_cost_total`. Identita dalších statistik nezávisí na fyzické
výměně elektroměru. Peněžní statistiky mají CZK a explicitní `unit_class=None`;
energetické kWh a `unit_class=energy`; obě explicitní `mean_type=NONE`.

## Energy a návrat

Integrace upravuje Energy pouze přes `EnergyManager.async_update`, validuje
vlastní zdroj stejným validátorem jako `energy/validate` a před změnou uchová
původní preferences i přesně měněný zdroj. Původní vlastní PND ID se aktualizuje
na místě, ostatní zdroje se zachovají. Neidentifikovaný cizí grid import vyvolá
opravitelný konflikt. Uživatel může v nativním nastavení výslovně označit starý
zdroj stejného odběrného místa k nahrazení; integrace jej nikdy nehádá.

Akce `cez_pnd.rollback` vypne nový import a obnoví pouze vlastní změnu Energy.
Změny provedené mezitím uživatelem na jiných zdrojích se zachovají. Pokud někdo
upravil i vlastněný zdroj, automatický rollback jej odmítne přepsat. Historická
měření a Recorder statistiky se nemažou ani při odstranění integrace.

Při návratu k samostatnému provozu lze po rollbacku vrátit aplikaci do režimu
`legacy`. Pomocník `deploy/native_deploy.py rollback` provede obě části v tomto
pořadí a použije soukromou zálohu původních voleb aplikace uloženou přímo v HA.

Nativní akce: `backfill`, `recalculate_costs`, `rollback`, `resume`, `export_history`.
Žádné helpery, utility metery, MQTT topics ani ručně upravovaný YAML.

## Nasazení a vývoj

Komponenta vyžaduje HA Core 2026.11+. Automatizovaný pomocník se spouští uvnitř
stávajícího HA SSH prostředí a má fáze `prepare`, `transport`, `setup`, `verify`,
`rollback`. Existující PND přístupové údaje neopouštějí HA a nepřenášejí se do
gitu ani do nativní integrace. Při instalaci komponenty je nutný řízený restart
Core před vytvořením Config Entry.

Lokální testy skutečného HA Core a SQLite Recorderu:

```sh
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python -r requirements-test.txt
.venv/bin/python -m pytest tests
npm --prefix cez-pnd-scraper test
npm --prefix cez-pnd-scraper run test:browser
npm --prefix cez-pnd-scraper run check
```

Ověření zahrnuje Config/Options Flow, skutečný import a zpětné čtení Recorderu,
opakování a opravy, restart po získání dat před zápisem, reload a odinstalaci,
změnu ceny, auth/reauth, explicitní migraci cizího zdroje a rollback.
Syntetické testy nenahrazují ověření dostupnosti skutečné historie v PND.


Verze 0.5.1 rozlišuje autoritativní hlášení portálu o období bez zdrojů od
neúplného měření a dočasného výpadku. Nedostupný měsíc se během běhu dotáže
jednou a nenutí opakované přihlášení. Pravidelná oprava upřednostňuje nejnovější
chybějící dny, aby neúplný začátek historie neblokoval skutečné pozdější výpadky.
Výslovná akce `backfill` umí obnovit import i po rollbacku; předem znovu ověří
vlastníka zápisu a vyjedná dostupné možnosti transportu.

Pro kontrolu archivu lze v HA terminálu použít `deploy/audit_history.py`.
Nástroj pouze čte vlastní archiv a vypisuje měsíční součty a kvalitu; nečte ani
nevypisuje PND přihlašovací údaje, tokeny, URL nebo fyzická ID měřičů.
