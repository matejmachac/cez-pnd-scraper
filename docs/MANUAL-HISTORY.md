# Import ručních odečtů a denních odhadů

Nativní verze 0.6.0 přijímá soukromý JSON vytvořený z exportu Numbers do XLSX.
Zdrojový sešit se nemění; do repozitáře se neukládá. Příprava vybere pouze
čtyři tabulky Electricity T1/T2 pro dvě navazující období. Ostatní tabulky,
platby a orientační ceny 7/6 Kč nejsou potvrzenými vstupy cenového modelu.

V tomto importu uživatel potvrdil skutečné nuly NT do 20. 1. 2025 a dal
přednost faktuře před rozporným řádkem 21. 6. 2026. Oba tarifní údaje tohoto
řádku jsou vynechány. Starý měřič končí odečtem z 1. 6. podle faktury, nový
začíná samostatnou počáteční hodnotou 2. 6. Z měřičů se nikdy neodečítají
navzájem jejich kumulativní registry.

## Výpočet

Datum ručního odečtu bez času se chápe jako konec uvedeného místního dne.
Například rozdíl 31. 12.–3. 1. se rozdělí do 1., 2. a 3. ledna. Také na DST
jde o stejné kalendářní denní průměry; nevytváříme údajné čtvrthodinové profily.

Pro každý interval dvou registrů stejného fyzického měřiče se:

1. Od rozdílů VT/NT odečtou skutečné naměřené denní tarify PND.
2. Zachovají skutečné profily PND. Pokud profil nemá známý tarif, odhadne se
   pouze rozdělení jeho známé energie v poměru zbylého VT/NT.
3. Zbytek VT a NT rozdělí rovnoměrně mezi dny bez úplného měření. Zbytkové
   miliardtiny kWh se rozloží kumulativními celočíselnými hranicemi, takže
   součet zůstane přesně shodný s rozdílem registrů.

Účtované měsíční odečty z dodané faktury doplňují přechod k PND a vymezují
zbytky v chybějících srpnových a zářijových dnech. Faktura má celé kWh;
PND má jemnější přesnost. Drobné rozdíly součtu profilu a tarifů zůstávají
zachované a nejsou opravovány přepsáním naměřených profilů.

Pokud PND převýší dostupný rozdíl registrů, dotčený odhad se nepoužije a
vznikne Repairs upozornění. Naměřené PND zůstává zachované.

## Uložení, opravy a zobrazení

PND soubory `.storage/cez_pnd.<entry>.history.<month>` se importem ručních dat
nemění. Odvozené odhady jsou samostatně v `.manual.<month>`; původní kotevní
odečty, datum, zdrojový list/buňky, hash sešitu a vynechané řádky jsou v soukromém
stavu vlastní integrace. Efektivní historie vždy vybírá naměřený profil PND,
případně použije odhad jen pro chybějící den nebo jeho neznámý tarif.

Každý zápis statistik znovu vyhodnotí původní odečty proti aktuálním PND datům.
Když PND doplní den, automaticky převezme přednost a zbytek odhadu se přerozdělí
mezi zbývající dny. Oprava přehraje i navazující kumulativní statistiky.
Checkpoint před publikací umožňuje zopakovat nejednoznačný/přerušený import.

Celková statistika a jeden fyzický grid zdroj zůstávají stejné. Jejich názvy
upozorňují na denní odhady, senzory uvádějí počet a rozsah odhadovaných dní.
Na hodinovém grafu se odhad objeví jako denní snapshot u konce dne; nejde o
naměřenou hodinovou křivku. Kvalita tarifů je `daily_measured_and_estimated`.
Nákladové statistiky rozlišují známé ceníky a odhady. Náklady před 18. 9. 2025
nejsou potvrzené: sešit obsahuje pouze orientačních 7/6 Kč bez popisu poplatků.

Akce `cez_pnd.import_manual_history` přijímá pole `file`, relativní JSON cestu
uvnitř konfigurace HA. Vstup má `schema_version=1`, `supply_point` a pole
`anchors` s `boundary` (místní půlnoc), `meter_id`, `vt`, `nt` a `source`.
Příprava XLSX je v `deploy/prepare_manual_history.py`, mimo runtime Core.

Akce `cez_pnd.disable_manual_history` ponechá zdrojové odečty a přepočte
statistiky zpět na PND. Staré denní příspěvky odhadu vynuluje přes oficiální
Recorder API a přehraje následné součty; žádnou databázi nebo cizí zdroj nemaže.
Celkový rollback do původního standalone provozu je nadále samostatná akce
`cez_pnd.rollback` a původní deploy pomocník.

Před produkční migrací byla soukromá záloha komponenty a archivu uložena v HA
jako `/config/.cez_pnd_migration/pre-manual-history.tgz` s oprávněním 600.

## Produkční import 9. 11. 2026

Bylo použito 59 kotev: 51 párových ručních odečtů z nezměněného sešitu a
8 fakturačních mezních bodů. Dva z nich nejsou fyzickými odečty: rozdělení
účtované spotřeby při změně ceny 19. 11. 2025 a distributorem odhadnutý konec
roku. Mají výslovně uvedenou kvalitu `billing_estimate` a nepředstírají měření.
Tyto mezní body zachovávají cenu účtovanou v jednotlivých cenových obdobích,
přičemž původní ruční návštěvy měřiče zůstávají dalšími kotvami.

Efektivní historie má **677 dní od 1. 1. 2025 do 8. 11. 2026**: 580 nových
celodenních odhadů a 97 původních úplných profilů PND. U jednoho z těchto
profilů (31. 7.) je odhadnutý jen tarifní poměr. Celkem proto diagnostika
uvádí 581 dní s nějakou odhadovanou složkou. Všech pět původních měsíčních
souborů PND bylo porovnáno s předimportní zálohou a je shodných bajt po bajtu.

| Období | Energie | Známá nákladová část |
|---|---:|---:|
| 2025 | 9903,00 kWh | 21424,77 Kč, pouze od 18. 9. |
| 2026 do 8. 11. | 8090,25 kWh | 37068,09 Kč |
| Celkem | 17993,25 kWh | 58492,865591061 Kč |

Tarifní součty jsou VT 2644,557 kWh a NT 15348,701 kWh. Jejich součet se od
celkového profilu liší o 0,008 kWh vlivem již existujícího zaokrouhlení PND.
Náklady před 18. 9. 2025 zůstávají neoceněné pro 260 dní. Částka v ročním
Energy přehledu 2025 proto není kompletní roční cenou.

Pro fakturační období 18. 9. 2025–30. 9. 2026 vycházejí přesně VT 1265 kWh a
NT 10291 kWh, tedy fakturovaných 11556 kWh. Součet profilů je 11555,996 kWh,
rozdíl je pouze 0,004 kWh. Nákladový model dává 55163,596076508 Kč oproti
55163,39 Kč na faktuře. Rozdíl přibližně 0,21 Kč odpovídá zvolenému přesnému
kalendářnímu rozpočtu měsíčních poplatků a jinému zaokrouhlení fakturačních
položek; nebyla vložena umělá korekční spotřeba nebo platba.

Po doplnění mají červenec 456,00 kWh, srpen 447,9965 kWh a září 307,9995 kWh.
Tyto měsíce obsahují odhady. Říjen 423,1075 kWh a listopad 218,1465 kWh zůstaly
beze změny. Aktuální listopadová cena zůstala 985,86 Kč.

Při kontrole roku 2025 byly odhaleny také dva staré, už nedefinované grid
zdroje `sensor.electricity_t1_manual` a `sensor.electricity_t2_manual`. Uživatel
výslovně potvrdil, že patří k téže Dubnici. Byly odpojeny přes nativní Energy UI;
jejich statistiky nebyly odstraněny. Před změnou jsou preferences soukromě
zálohované v `/config/.cez_pnd_migration/pre-manual-energy-prefs.json`.
Energy nyní má jediný grid zdroj; rok 2025 vizuálně zobrazuje přesně 9903 kWh
bez původních dodatečných 357,98 kWh ze starých zdrojů.

Skutečný import byl zopakován nad celým produkčním datasetem a všechny součty
zůstaly identické. Každou dávku zkontroloval Recorder readback. Nativní
komponenta 0.6.0 prošla `ha core check` a restartem před importem. Celá HA sada
má 31 úspěšných testů; nové scénáře pokrývají také DST, nuly NT, výměnu měřiče,
konfliktní odečty, přednost PND, nahrazení odhadu opraveným měřením, opakování,
reload a vypnutí odhadů. Dodatečné ověření služby zahrnulo odmítnutí cesty mimo
konfiguraci a skutečné načtení JSON souboru přes HA službu.
