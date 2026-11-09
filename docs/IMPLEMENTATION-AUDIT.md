# Audit implementace a nasazení – 9. listopadu 2026

## Výchozí řešení

Repozitář původně obsahoval HAOS aplikaci 0.4.1, nikoli HA Custom Integration.
Playwright/Chromium se přihlašuje přes CAS a uchovává soukromou session v
`/data/browser-state.json`. CSV export dekóduje Windows-1250; průměrný výkon
čtvrthodinového profilu dělí čtyřmi na kWh. Původní import zapisoval externí
hodinové statistiky přes Supervisor WebSocket a uchovával checkpoint v
`/data/state.json`. Energy již používalo jeden PND grid zdroj. Tato identita
celkové spotřeby byla zachována, historie se nemaže.

Původní Core 2026.10.4 a HAOS 18.3 byly se souhlasem uživatele aktualizovány na
Core **2026.11.0** a HAOS **18.4**, se zálohou a ověřeným návratem po restartu.
Supervisor zůstal 2026.10.5. Testy používají skutečný Core 2026.11.0 na Pythonu
3.14 a SQLite Recorder, nikoli simulaci HA API.

## Ověřené skutečné zdroje PND

PND 2.6.1 poskytuje sestavu **01 Profil spotřeby (+A)** v kW, sestavu **07**
s denní energií a sestavu **17 Registry za den (+E,-E)** v kWh. Číslo 17 tedy
v tomto účtu neoznačuje měsíční registry ze zadání. Export obsahuje `+E`,
`+E_NT`, `+E_VT`; konkrétní kódy OBIS v něm nejsou výslovně uvedeny.
Sestava 18 nebyla v dostupné rychlé sestavě nabídnuta. Virtuální tarify nemají
žádné záznamy; nevytváříme z nich údajné autoritativní hodinové měření.

Každý kanál má vlastní trojici Datum/hodnota/Status. Odečet ve 24:00 patří
konci místního dne; UTC hranice respektuje Europe/Prague a DST. Čísla závisí
na jazyku browseru: en-US export `2,288.142`, český Playwright export
`2 288,142`. Verze 0.5.1 používá explicitní jazyk exportu a správně čte i
české `371,439` pod 1000 kWh. Regresní test zahrnuje skutečný zjištěný formát.

Referenční 8. listopad: profil **51,34575 kWh**, denní sestava 07 **51,346 kWh**,
rozdíl registrů **VT 5,160 + NT 46,186 = 51,346 kWh**. Rozdíl profilu a
registrů odpovídá zaokrouhlení registrů na 0,001 kWh. Cena podle dodaného ceníku
je VT 21,64847040 Kč, NT 158,10114404 Kč, fixní část 842/30 Kč,
celkem **207,8162811067 Kč**. Registry jsou denní, ne hodinové; tarifní
spotřebu ani náklady nevymýšlíme rovnoměrným dělením po hodinách.

Budoucí řádky PND mohou obsahovat nuly/pomlčky a nejsou dokončeným měřením.
Například 20. srpen obsahuje jen 89/96 naměřených intervalů; neúplné dny
se nedoplňují nulami. Výslovné hlášení portálu „Pro danou konfiguraci nejsou
k dispozici žádné datové zdroje“ se odlišuje od výpadku, změny schématu a
neúplného exportu; nezpůsobuje zbytečné mazání přihlašovací session.

## Architektura

Stávající aplikace 0.5.1 zachovává CAS a Chromium. V režimu `native` slouží
pouze jako autentizovaný transport měření; původní scheduler a zapisovač jsou
vypnuté. Režim `legacy` zachovává samostatné původní použití. HA Core nemá
browser runtime; jeho přidání do Core by vyžadovalo přepis funkčního transportu.

Python komponenta `custom_components/cez_pnd` vlastní Config/Options/Reauth
Flow, zařízení se 13 entitami, Repairs a služby. Připojení přes
`supervisor://<slug>` zjišťuje aktuální IP aplikace pomocí Supervisor API;
nespoléhá na v tomto nasazení nefunkční `.local.hass.io` DNS ani pevnou IP.
Transportní token umožňuje jen lokální čtení měření. PND heslo zůstává v aplikaci.

HA Store archivuje měsíce s UTC intervaly, fyzickým měřičem, zdrojem, kvalitou,
registrem na obou hranicích dne, hashem, revizí a časem získání. Samostatný stav
obsahuje checkpoint a chybějící/nedostupná období. Nový měsíční export při
opravě obnovuje **obě** hranice dne, i když předchozí archiv obsahuje staré hodnoty.
První průzkum pokrývá až 36 měsíců. Běžná kontrola obnovuje posledních 7 dní a
omezenou dávku chybějících měření. Nedostupné měsíce se nestahují každý den.

Jediný zapisovač používá `async_add_external_statistics`, explicitní metadata
HA 2026.11 a dávky nejvýše 744 hodin. Každou dávku ověřuje zpětným čtením přes
Recorder API; checkpoint neposouvá jen na základě zařazení do fronty. Při opravě
přehrává navazující kumulativní součty, aby nevznikly záporné skoky. Entity
nemají `state_class`, a proto nekompilují druhou kopii těchto statistik.

## Ceny a Energy

Jedna grid source zachovává původní celkovou energii a používá externí
`cost_total`. Dalších šest statistik obsahuje VT/NT a jednotlivé náklady;
tarify se do energetického toku podruhé nepřičítají. Konfigurace probíhá přes
`EnergyManager.async_update` a oficiální validaci; žádný přímý zápis do
`.storage/energy` nebo DB Recorderu.

Potvrzený výchozí ceník pokrývá **1. 10.–31. 12. 2026**: VT 4,19544 Kč/kWh,
NT 3,42314 Kč/kWh, fixní složka 842 Kč/měsíc včetně DPH. Ceny před říjnem a
regulované ceny 2027 nejsou potvrzené a nedosazují se. Options Flow umožňuje
verzované intervaly a samostatnou změnu VT/NT/fixní složky. Fixní část se dělí
podle kalendářních dní a 23/24/25 hodin tak, aby celý měsíc činil přesně 842 Kč.
Zálohy, starý nedoplatek a bankovní pohyby do nákladů nevstupují.

## Migrace a návrat

Soukromá záloha původních voleb aplikace a nový transportní token jsou pouze
v `/config/.cez_pnd_migration`, oprávnění 700/600. Energy záloha je součástí
vlastního HA Store. Cizí zdroje se zachovávají. Neznámý cizí grid vyvolá
konflikt; Options Flow dovoluje výslovné označení zdroje stejného místa.

Akce `cez_pnd.rollback` vypne nový import a vrátí vlastní změnu Energy.
Byla skutečně spuštěna při opravě registrů; historie zůstala zachovaná.
Vypnutí přetrvá restart Core. Výslovný `backfill` umí bezpečně obnovit zvolený
rozsah po kontrole, že transport je v nativním režimu. Úplný návrat včetně
původního scheduleru provede v HA terminálu:

```sh
python3 /config/cez_pnd_deploy/native_deploy.py rollback --app a894bec6_cez_pnd_scraper
```

Statistiky se nemažou ani při odinstalaci integrace. Pokud uživatel mezitím
změní vlastněný Energy zdroj, rollback jej automaticky nepřepisuje.

## Ověření

- Python: **26 testů prošlo** na skutečném HA Core 2026.11.0/Recorder/Energy.
- Node: **73 testů prošlo**, 8 Chromium scénářů se spouští samostatně.
- Chromium: **8 scénářů prošlo**, včetně českých registrů a období bez zdrojů.
- JS syntaxe, Ruff a whitespace kontrola prošly.

Scénáře zahrnují čistou instalaci, existující Energy, opakování importu,
opravy, přerušený checkpoint/restart, výpadek/auth/reauth, chybějící den,
DST, reset/výměnu měřiče, nulovou spotřebu s fixním poplatkem, změnu ceníku,
upgrade/reload, konflikty cizích zdrojů, rollback a odinstalaci bez ztráty dat.

Nasazení 0.5.1 a Core restart jsou ověřené. Konečný rozsah skutečně dostupné
historie, měsíční součty a zobrazení nákladů se doplňují po dokončení běžícího
produkčního backfillu; referenční faktura 2025/2026 se bez příslušných původních
měření nesmí považovat za nezávisle rekonstruovanou.

## Technické reference

Kontrolované zdroje skutečného Core 2026.11.0:

- https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/opower/coordinator.py
- https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/energy/data.py
- https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/energy/websocket_api.py
- https://github.com/home-assistant/core/blob/2026.11.0/homeassistant/components/recorder/statistics.py
