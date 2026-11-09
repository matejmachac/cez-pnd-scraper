# Historický ceník doplněný z faktury

Dne 9. 11. 2026 uživatel poskytl fakturu za období 18. 9. 2025–30. 9. 2026
a výslovně povolil odvození předříjnových cen. PDF zůstává soukromé mimo git;
přeneseny jsou pouze odvozené cenové intervaly do nativního Options Flow v HA.
Předchozí nastavení této integrace je zálohované pouze v soukromém adresáři HA.

## Odvození cen

Kontrolovány byly celé relevantní stránky 2–4. Variabilní cena je součtem
obchodní ceny, distribuce příslušného tarifu, systémových služeb, daně
z elektřiny a skutečně účtované POZE; Kč/MWh se dělí 1000 a násobí 1,21.
Nejde o průměr celkové faktury dělený spotřebou. Zálohy a nedoplatek se ignorují.

| Platnost od (včetně) | Platnost do (bez) | VT Kč/kWh s DPH | NT Kč/kWh s DPH | Fixní Kč/měsíc s DPH |
|---|---|---:|---:|---:|
| 18. 9. 2025 | 19. 11. 2025 | 5,7029599 | 4,9792710 | 737,43 |
| 19. 11. 2025 | 1. 1. 2026 | 4,7621607 | 4,1384662 | 737,43 |
| 1. 1. 2026 | 1. 10. 2026 | 4,1954451 | 3,4231384 | 842,00 |

Příklad roku 2026: VT = (2520 + 754,77 + 164,24 + 28,30 + 0) / 1000 × 1,21.
NT používá distribuci 116,50 Kč/MWh. Faktura v roce 2026 účtuje POZE nula,
v roce 2025 účtuje podle spotřeby 495 Kč/MWh. Fixní složka obsahuje stálou
platbu 128 Kč, jistič 555 Kč a nesíťovou infrastrukturu 12,87 Kč bez DPH;
výsledných 842,0027 Kč je podle zvolených pravidel měsíčního ceníku zaokrouhleno
na 842,00 Kč. V roce 2025 jsou jistič 469 Kč a infrastruktura 12,45 Kč,
celkem po DPH a zaokrouhlení 737,43 Kč/měsíc.

Původní potvrzený ceník od října 2026 zůstává 4,19544 / 3,42314 / 842,00.
Drobný rozdíl proti přesnému součtu složek předchozí faktury je původním
zaokrouhlením a nepřepisuje již dohodnuté ceny. Pro rok 2027 se nic nedoplňuje.

## Rozsah a úplnost nákladů

Přepočet používá uložená měření od 31. 7. 2026. V srpnu a září účtuje plných
842 Kč fixních plateb za měsíc, i v chybějících dnech. Za jediný zahrnutý
červencový den jde o 842/31 Kč. Spotřeba chybějících dnů se nevymýšlí;
rok 2025 a první polovina 2026 nemají dostupné PND profily a cenový interval
sám žádnou spotřebu nevytváří.

Předříjnové známé nákladové části jsou:

| Období | Naměřené dny | Známá variabilní složka + fixní platby |
|---|---:|---:|
| 31. 7. | 1, bez páru tarifních registrů | pouze 27,161290323 Kč fixně |
| Srpen | 28 z 31 | 2302,0804999473 Kč |
| Září | 29 z 30 | 1873,2645427326 Kč |

**Tyto historické částky nejsou kompletní náklady celých měsíců.** Faktura
potvrzuje v srpnu 448 kWh (72 VT + 376 NT) a v září 308 kWh (44 VT + 264 NT),
zatímco dostupné úplné PND profily dávají 411,8095 a 291,7645 kWh. Rozdíly
36,1905 a 16,2355 kWh se do hodin rovnoměrně nerozdělují. Celé vyúčtování
11 556 kWh a 55 163,39 Kč proto není vydáváno za nezávisle rekonstruovanou
hodinovou historii. Faktura potvrzuje výměnu měřiče 2. 6. 2026.

Senzor nákladů uvádí `incomplete_priced_days` vedle `price_periods` a
`unpriced_measured_days`. Úplná současná cenová perioda od října zůstává
připojená k Energy i při mezeře v oddělené starší periodě. To brání tomu,
aby dopočet starších neúplných měsíců skryl správné říjnové/listopadové náklady.


## Skutečné nasazení a ověření

Tři historické intervaly byly úspěšně uloženy oficiálním Options Flow; původní
říjnový interval zůstal beze změny. Komponenta 0.5.2 prošla `ha core check`,
řízeným restartem a obnovením importu po přerušení. Akce
`cez_pnd.recalculate_costs` přepočetla 31. 7.–8. 11. 2026 a každou dávku
ověřila přes Recorder API. Nedošlo ke změně energie: stále 1370,54325 kWh.
Známá nákladová část je 7531,7758475559 Kč, s 5 neúplnými dny a žádným
uloženým naměřeným dnem bez ceníku. Je to součet známých složek, nikoli
úplné vyúčtování. Stav synchronizace je `idle`.

Vizuálně ověřené hodnoty Energy: srpen 2302,08 Kč, září 1873,26 Kč, říjen
2343,41 Kč, listopad 1.–8. 11. 985,86 Kč a 8. 11. samostatně 207,82 Kč.
Testy skutečného HA Core/Recorder/Energy: 28 úspěšných, včetně mezery ve staré
cenové periodě při úplné nové periodě. Původních 73 Node a 8 Chromium testů
zůstává úspěšných; transportní kód se pro doplnění ceníků neměnil.
