# Zakupy i awizacje — propozycja dopasowania UI do Fondaco

**Date**: 2026-09-19
**Status**: Etap 1 wdrożony (moduł `src/modules/procurements`); etap 2 (awizacje) nadal propozycja

## TLDR

Propozycja dopasowania istniejących specyfikacji WM22 do Fondaco: etap 1 obejmuje zamówienia zakupu i ich pozycje; etap 2 awizacje połączone z obecnym przyjęciem. Zamówienia powstają bez obowiązkowego zapotrzebowania. Nowe ekrany powtarzają układ zamówień klientów, a planowany osobny moduł dostawców pozostaje właścicielem kartoteki.
Dokument jest wspólną propozycją produktową i mapą różnic względem WM22. Szczegółowe specyfikacje wykonawcze PO i ASN pozostają osobnymi zakresami; dokument nie zatwierdza zmian schematów ani uruchomienia migracji.

## Resolved Scope Decisions

2026-09-19 — użytkownik wybrał dwa etapy: zamówienia wraz z pozycjami, następnie awizacje. Zamówienia można tworzyć bez wcześniejszego zapotrzebowania. Przyszłe zapotrzebowania pozostają rozszerzeniem, nie warunkiem pierwszego wdrożenia. Odpowiedzi zatwierdzają kierunek propozycji, nie uruchamiają implementacji.

## Problem Statement

WM22 na gałęzi codex/wms2-specification, commit 7aed7960e3b38c2502a970c0233f2eb3fd5bbf49, jest repozytorium dokumentacji. Istnieją docs/specs/2026-09-19-purchase-orders.md oraz 2026-09-19-inbound-deliveries.md. Nie należy przedstawiać ich jako działających modułów.
Fondaco ma pz oraz warehouseman: dokument oczekiwany, palety, liczenie i porównanie. Potwierdzenie dokumentu nie wykonuje postingu stanu. Aktualne GoodsReceipt przechowuje supplierName, bez kartoteki dostawców.

## Overview and Success Measures

Cel: utworzyć zamówienie bez PR, odnaleźć każdą jego pozycję na liście zbiorczej, a w etapie 2 utworzyć awizację z wybranych pozycji bez ponownego wpisywania produktu i dostawcy. Z listy zamówień dotarcie do pozycji i utworzenia awizacji: najwyżej trzy przejścia.
Miary odbioru: 100% pozycji awizacji wskazuje pozycję PO; zero awizacji ponad wolny limit przy równoległych zapisach; zero automatycznych zmian stanu magazynowego po samym liczeniu; zachowana historia dostawcy i produktu.
Punkt odniesienia: dokumentacja Odoo „Two-step receipt and delivery” (https://github.com/odoo/documentation/blob/master/content/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/receipts_delivery_two_steps.rst, odczyt 2026-09-19). Przyjmujemy oddzielenie przyjęcia od odłożenia. Nie przenosimy całego mechanizmu tras ani jego reguł dostępności zapasu; te należą do lokalnego WMS. Źródłem projektu pozostaje WM22, źródłem wyglądu sales 0.8.0.

## Goals

- REQ-001 — Kupiec tworzy, edytuje i zatwierdza PO bez PR oraz przegląda jego pozycje.
- REQ-002 — Zbiorcza lista pozycji pokazuje terminy i ilości tych samych rekordów co zamówienie.
- REQ-003 — Dokumenty używają przyszłej kartoteki dostawców i zachowują historyczny snapshot.
- REQ-004 — Awizacja rezerwuje dostępne ilości konkretnych pozycji PO tego samego dostawcy i magazynu.
- REQ-005 — Przyjęcie zachowuje źródłowe pozycje i rozdziela awizowanie, liczenie oraz posting.
- REQ-006 — Ekrany są spójne z sales, dostępne z menu, lokalizowane i chronione zakresem/uprawnieniami.

## Non-goals

Ten dokument nie wdraża funkcji ani nie zmienia publicznych kontraktów, schematów, istniejących specyfikacji WM22 i PZ. Nie dodaje automatycznie całego WMS2, Androida, KJ, płatności, podatków ani nowej kartoteki dostawców.

## Proposed Solution

`procurements` jest właścicielem PO i jego pozycji. Pozycja nie stanowi osobnego modułu: jest częścią zamówienia z własnym identyfikatorem i widokiem zbiorczym. `inbound_deliveries` odpowiada za awizacje i ich pozycje. Istniejące PZ i Panel obsługują przyjęcie i liczenie; nie budujemy drugiego panelu przyjęcia.
Dostawca należy do powstającego modułu dostawców. PO i ASN zawierają odwołanie oraz snapshot nazwy, kodu i danych dokumentowych. Szczegółowy interfejs kartoteki trzeba uzgodnić przed implementacją; nazwa `suppliers` jest robocza, nie istniejącym kontraktem.
Do czasu gotowości kartoteki proponujemy zapisywanie szkiców z nazwą dostawcy. Zatwierdzenie i awizowanie wymagają jednoznacznie wybranego aktywnego dostawcy. Brak modułu wyświetla wyjaśnienie blokady; nie tworzymy tymczasowej drugiej bazy dostawców. Pełny odbiór etapu 1 wymaga gotowego wyboru dostawcy.
Różnice wobec WM22: obowiązkowe PR usunięte na życzenie użytkownika; SupplierProfile w procurements zastępuje docelowe powiązanie z osobnym modułem dostawców. Dokumenty WM22 nie zostały automatycznie zmienione. Ich reguły limitów i rozdział oczekiwania/liczenia/postingu pozostają wzorcem.

## Domain Vocabulary and Business Rules

Proponowany przebieg: PO → pozycja PO → jedna lub wiele pozycji awizacji → dostawy/przyjęcia → potwierdzony ruch magazynowy.
Wolne do awizacji uwzględnia anulowania, potwierdzone przyjęcia, aktywne zobowiązania awizacji i posting w toku; nie jest równe pozostałemu do dostarczenia. Przykład: zamówione 100, aktywnie awizowane 60, przyjęte 0: do dostarczenia 100, wolne do awizacji 40.
Formuła dla pozycji: wolne = zamówiono − anulowano − postedNet − inflight − outstandingCommitments; wszystkie składowe rozłączne i w tej samej UOM. Pozostało do dostarczenia = zamówiono − anulowano − postedNet; inflight oznacza oczekiwanie na potwierdzenie, nie wolną ilość. Liczenie samo nie przenosi między tymi licznikami. Transfer outstanding→inflight→posted nie zwiększa sumy wykorzystania limitu. Wartość ujemna jest błędem spójności, nie powodem cichego przycięcia.
Anulowanie lub zmniejszenie PO nie może zejść poniżej postedNet+inflight+outstanding. Po aktywnej awizacji nie zmieniamy dostawcy/magazynu PO. Zamknięcie nie kasuje brakującej ilości: niewykonana reszta musi być anulowana z powodem albo ponownie zaplanowana.
Ten sam SKU na dwóch pozycjach PO wymaga zachowania wskazania konkretnej pozycji. Aktualne sumowanie palet według produktu nie jest wystarczającym dowodem rozliczenia PO.
Stany projektowe PO z WM22: DRAFT, RELEASED, PARTIALLY_RECEIVED, RECEIVED, CLOSED, CANCELLED. RELEASED nie oznacza wysłania do dostawcy. Status realizacji wynika z potwierdzonego postingu, nie z policzenia.

## Users, Permissions, and Scope

Kupiec: odczyt/tworzenie/edycja szkiców PO, osobne uprawnienie do zatwierdzania i korekt. Planista: tworzenie i uwalnianie awizacji. Magazynier: istniejące uprawnienia Panelu i przydział magazynu, bez cen zakupu w panelu liczenia. Kierownik: decyzje o różnicach i kontrolowane anulowanie reszty.
Proponowane rodziny feature IDs: procurements.view/manage/release i inbound_deliveries.view/manage/release; dokładne ID do ustalenia w specyfikacjach wykonawczych. Nie stosować guardów po nazwie roli.
Tenant i organizacja pochodzą z uwierzytelnionej sesji i wybranego scope, nie z payloadu. Brak któregokolwiek zakresu blokuje operację. Picker produktów, dostawców i magazynów oraz każda mutacja weryfikują ten sam zakres. Nie przewiduje się scope systemowego.

## Reuse and Ownership Map

| Zakres | Właściciel | Zasada |
|---|---|---|
| PO, pozycje, rewizje, limit awizacji | procurements | Jedna odpowiedzialność za ilości zamówione |
| Awizacja, ETA, pozycje i realizacje dostawy | inbound_deliveries | Referencje do konkretnych pozycji PO |
| Dostawca | przyszły moduł dostawców | UUID + historyczny snapshot; bez nowej kartoteki w zakupach |
| Produkt/wariant i jednostka | catalog | Picker i snapshot; nie osobny katalog zakupowy |
| Magazyn/lokalizacja/ruch | WMS | Jedyna księga zapasu |
| Liczenie, palety i zestawienie | istniejące pz/warehouseman | Zachować UX; rozszerzyć śledzenie źródłowej pozycji |
| Wygląd dokumentów | sales i wspólne UI | Wzorzec kompozycji, bez używania SalesOrder jako PO |

## Architecture and Data Flow

```text
Kartoteka dostawców + katalog + magazyny
                  ↓
PO → pozycje PO → rezerwacja limitu awizacji
                           ↓
                      ASN → przyjęcie PZ → liczenie palet
                                                ↓
                                potwierdzony posting WMS
                                                ↓
                                rozliczenie pozycji PO/ASN
```
Referencje między modułami to identyfikatory i snapshoty, nie relacje ORM. Mutacje przez komendy; efekty/eventy po commit. Limit awizacji kontroluje procurements we własnej transakcji. Status przejściowy ASN pozostaje widoczny do potwierdzenia rezerwacji wszystkich pozycji.
Komponentów biznesowych sales nie należy kopiować ani rozszerzać o sztuczny typ zamówienia sprzedaży; współdzielone są canonical UI primitives. Dotychczasowe PZ, eventy i adresy zachowują kompatybilność; rozdzielenie Awizo/PZ trzeba uzgodnić z już planowanymi pracami, bez równoległego modelu.

## User Journeys

J-001: Kupiec otwiera Zakupy → Zamówienia → Dodaj; wybiera dostawcę i magazyn, dodaje produkty, ilości, ceny oraz terminy. Zapisuje szkic, sprawdza i zatwierdza. Zapotrzebowanie nie jest wymagane. Nieaktywny dostawca/produkt blokuje zatwierdzenie. Nieudany zapis zachowuje wpisane wartości.
J-002: Kupiec otwiera Pozycje zamówień, filtruje po terminie/dostawcy, przechodzi do PO. Nie zmienia pozycji z pominięciem wersji i reguł zamówienia.
J-003: Planista zaznacza pozycje zgodnych PO, wybiera Utwórz awizację, wpisuje ilości i ETA. Formularz pokazuje wolny limit. Konflikt po równoległym zapisie odświeża dostępność, zachowuje intencję i wymaga świadomej korekty, bez cichego przycinania.
J-004: Magazynier przechodzi z awizacji do powiązanego przyjęcia i istniejącego liczenia. Dla dwóch pozycji z tym samym SKU operator wskazuje źródło lub uprawniony użytkownik rozdziela wynik przed rozliczeniem. Nierozdzielone ilości nie aktualizują realizacji PO.
J-005: Kierownik widzi niedobór, nadwyżkę lub błąd postingu. Niedobór pozostaje na otwartej awizacji albo zostaje jawnie zwolniony do ponownej awizacji. Nadwyżka wymaga korekty PO/ASN przed postingiem. Niejasny wynik postingu pokazuje oczekiwanie na uzgodnienie, bez nowego przyjęcia.

## UI and Interaction Contracts

Źródła wzorca: @open-mercato/core@0.8.0, sales/backend/sales/orders/page.tsx → components/documents/SalesDocumentsTable.tsx (DataTable); sales/backend/sales/orders/[id]/page.tsx → backend/sales/documents/[id]/page.tsx (FormHeader, zakładki, podsumowanie, szczegóły). Inspekcja kodu; bez weryfikacji w przeglądarce. Obowiązuje .ai/guides/backend-ui.md.

Proponowane menu: Zakupy / Zamówienia zakupu / Pozycje zamówień / Dostawcy (po uruchomieniu modułu); Magazyn / Awizacje / istniejące Przyjęcia.

Lista zamówień: numer, dostawca, status, data, termin, magazyn, wartość netto i waluta. Filtrowanie po dostawcy, statusie, magazynie i terminie.
Szczegóły: nagłówek z numerem/statusem i akcjami; dane dostawcy, magazynu, terminów; zakładki Pozycje, Awizacje, Przyjęcia, Historia. Akcje Zapisz szkic, Zatwierdź, Utwórz awizację; korekta i anulowanie z warunkami.
Pozycje: produkt/SKU, jednostka, zamówiono, anulowano, aktywnie awizowano, policzono, zaksięgowano, wolne do awizacji, cena netto, wartość netto, termin. Globalny widok dodaje numer PO i dostawcę. Ilości porównywać w zgodnych jednostkach, bez zbiorczej sumy różnych UOM.
Awizacja: numer, dostawca, magazyn, ETA, brama/rampa, status; zakładki Pozycje, Przyjęcia, Palety, Różnice, Historia. Utworzenie z wybranych pozycji jednego lub kilku PO tego samego dostawcy i magazynu. Wyraźnie odrębne Zakończ liczenie, Zaksięguj i Rozlicz, przy czym posting wymaga osobnego wdrożonego kontraktu.

```text
ZZ/2026/001   [Zatwierdzone]             [Utwórz awizację] […]
Dostawca · Magazyn · Termin · Waluta
[Pozycje] [Awizacje] [Przyjęcia] [Historia]
SKU | Produkt | j.m. | Zamówiono | Awizowano | Zaksięgowano | Cena
```

Wspólny wygląd i komponenty z sales, osobny model zakupowy. DataTable, CrudForm, FormHeader, StatusBadge, apiCall; lokalizacja PL/EN. Każda powierzchnia obejmuje loading/empty/error/403/409, zachowanie klawiatury, wąski ekran i jasny/ciemny motyw.

### Inwentarz proponowanych ekranów

Adresy są robocze; przed wykonaniem należy sprawdzić zgodność nawigacji i trwającego podziału Awizo/PZ.

| Ekran | Roboczy adres | Kompozycja i akcje | Odczyt/mutacja |
|---|---|---|---|
| Lista PO | /backend/purchases/orders | Page/PageBody, DataTable, Dodaj, filtry | lista PO; przejście do szczegółów |
| Nowy PO | /backend/purchases/orders/create | CrudForm, grupy Dostawca/Magazyn/Warunki, edytor pozycji | create szkicu |
| Szczegóły/edycja PO | /backend/purchases/orders/[id] | FormHeader, zakładki, DataTable pozycji, CrudForm edycji | read/update/release/amend/cancel |
| Pozycje wszystkich PO | /backend/purchases/order-lines | DataTable, termin/status/dostawca, link do PO | read model pozycji; akcja Utwórz awizację w etapie2 |
| Lista ASN | /backend/wms/arrival-notices | DataTable, ETA/status/magazyn/dostawca | lista i Dodaj |
| Nowa ASN | /backend/wms/arrival-notices/create | CrudForm, picker pozycji PO, ilości i ETA | create/release |
| Szczegóły ASN | /backend/wms/arrival-notices/[id] | FormHeader, Pozycje/Przyjęcia/Palety/Różnice/Historia | read/amend/cancel, przejście do przyjęcia |
| Obecne przyjęcie | istniejący ekran PZ/Panel | zachowany shell; źródło PO/ASN i rozdział liczenia | istniejące operacje liczenia + kontrolowane powiązanie |

```text
Zamówienia zakupu                         [+ Zamówienie]
[Szukaj] [Dostawca] [Status] [Termin] [Magazyn]
Numer | Dostawca | Status | Termin | Wartość netto | Waluta

Nowe zamówienie
Dostawca [wyszukaj]         Magazyn [wybierz]
Data [       ]             Waluta [PLN]
Produkt [wyszukaj] | j.m. | Ilość | Cena netto | Termin
[+ Pozycja]                            [Anuluj] [Zapisz]

Pozycje zamówień                           [Utwórz awizację]
[Dostawca] [Termin] [Pozostało do realizacji]
PO/pozycja | Produkt | j.m. | Zamówiono | Wolne do awizacji

Awizacje                                  [+ Awizacja]
[Dostawca] [ETA od/do] [Magazyn] [Status]
Numer | Dostawca | ETA | Magazyn | Status | Różnice

Nowa awizacja
Dostawca [wybierz]      Magazyn [wybierz]      ETA [       ]
[Wybierz pozycje zatwierdzonych PO]
PO/pozycja | Produkt | j.m. | Wolne | Ilość awizowana
Brama/rampa [wybierz]                       [Zapisz szkic]

AW/2026/001 · Uwolniona                    [Przyjęcia] […]
Dostawca · Magazyn · ETA · Brama
[Pozycje] [Przyjęcia] [Palety] [Różnice] [Historia]
PO/pozycja | Produkt | Awizowano | Policzono | Zaksięgowano
```

Stan pusty wskazuje legalną akcję Dodaj lub wyjaśnia brak uprawnień; brak PO do awizacji kieruje do listy zamówień. Błąd odczytu ma Ponów, błąd zapisu zachowuje dane. Konflikt409 wyświetla komunikat i umożliwia odświeżenie z zachowaniem wpisanej intencji. Niedostępna akcja ma przyczynę, nie tylko kolor. Usunięcie szkicu i anulowanie wymagają dialogu; zmiana stanu blokuje podwójne wysłanie.
Pickery pokazują nazwy i kody, nie UUID. Źródła opcji są adapterami właścicieli rekordów; dokładne URL do uzgodnienia, nie nowe katalogi. Domyślny termin nagłówka PO podpowiada termin pozycji; po zatwierdzeniu zmiana terminu jest rewizją.
Klawiatura: tabulacja do filtrów/tabeli/akcji, widoczny focus, etykiety ikon; dialog Escape anuluje, Ctrl/Cmd+Enter zatwierdza. Komunikaty dostępne czytnikom ekranu. Na wąskim ekranie formularz jednokolumnowy, tabela przewijana z zachowanymi identyfikatorami; semantyczne tokeny i StatusBadge w obu motywach. Bez nowego dashboardu; start z menu do listy i dokumentu.

## Data Models

Model konceptualny, do przełożenia na osobne kontrakty wykonawcze PO i ASN:

| Rekord | Pola biznesowe |
|---|---|
| PurchaseOrder | numer, data, supplierId/snapshot, warehouseId/snapshot, waluta PLN, status, rewizja, kupiec, uwagi |
| PurchaseOrderLine | orderId, nr pozycji, variantId, snapshot SKU/nazwy/UOM, ilość zamówiona/anulowana, cena jednostkowa netto, termin |
| PurchaseOrderRevision | orderId, nr rewizji, niezmienny obraz dokumentu, powód, autor, data |
| Commitment | pozycja PO, pozycja ASN, ilość pozostała/zużyta/zwolniona, wersja |
| ReceiptCharge | pozycja PO, commitment, identyfikator operacji przyjęcia, ilość, stan, powiązanie korekty |
| ArrivalNotice | numer, supplierId/snapshot, warehouseId, ETA, brama/rampa, status, uwagi |
| ArrivalNoticeLine | noticeId, orderLineId, variantId/snapshot, jednostka, expectedQty, commitmentId |
| Powiązanie przyjęcia | pozycja ASN, konkretna pozycja przyjęcia i ilość rozliczona; rozdział wyników liczenia audytowany |

Wszystkie rekordy zawierają UUID, tenantId, organizationId, createdAt i updatedAt; zmiany użytkownika wymagają wersji. Decimal quantities/ceny bez obliczeń na niekontrolowanym float. Jednostka zakupowa w pierwszej wersji zgodna z jednostką przyjęcia; przeliczenia opakowań poza zakresem. Historyczne dokumenty zachowują snapshots; zatwierdzone PO nie są kasowane, tylko korygowane lub anulowane w dozwolonej części.
Cena >=0, ilość zamówiona >0, stabilny numer pozycji; UNIQUE(scope, typ, numer dokumentu) i UNIQUE(scope, orderId, lineNo). Numer nadaje serwer atomowo, bez max+1. Dokładny format serii nie jest obecnie kontraktem.
Dane kontaktowe/adresy dostawcy, jeśli potrzebne w snapshotach, podlegają istniejącej polityce szyfrowania; nie kopiować niepotrzebnych danych osobowych. PR nie jest polem wymaganym; przyszłe powiązanie dodawane osobno.

## API, Command, and Error Contracts

Zakres proponowanych operacji, nie deklaracja istniejących endpointów:

| Powierzchnia | Odczyt/mutacja | Reguła |
|---|---|---|
| Zamówienia | lista, szczegóły, create/update/delete szkicu | makeCrudRoute + command bus |
| Pozycje | odczyt w PO i globalny; zmiany przez komendę zamówienia | Jedna wersja agregatu, bez obchodzenia zamrożenia |
| PO release/amend/cancel remainder | dedykowane komendy domenowe | Walidacja dostawcy, rewizji i zobowiązań |
| Awizacje | CRUD szkicu, release/amend/cancel | Atomowa rezerwacja limitu po stronie procurements |
| Powiązania PZ | odczyt źródeł i kontrolowane utworzenie przyjęcia | Idempotency key i konkretna pozycja ASN |
| Pickery | dostawca/produkt/magazyn/brama | Nazwy użytkowe, scoped options; żadnego wpisywania UUID |

Każda przyszła trasa wymaga per-method metadata + openApi. Odczyty zwracają updatedAt, a update/delete i akcje wersjonowane wymagają oczekiwanej wersji. Błędy: 400 walidacja, 401 brak sesji, 403 brak uprawnień, 404 brak rekordu w zakresie, 409 wersja/limit/stan. Replay tej samej operacji nie duplikuje dokumentu ani zobowiązania; ten sam klucz z inną treścią jest konfliktem.
Dokładne URL, command/event IDs i seam dostawców są pracą specyfikacji wykonawczych, nie zatwierdzonym kontraktem tej propozycji. API nie jest potrzebne do realizacji obecnego zadania dokumentacyjnego.

## Events, Jobs, Notifications, and Cross-Module Flows

Zatwierdzenie PO udostępnia je do awizacji; nie oznacza wysłania dostawcy. Release ASN najpierw potwierdza rezerwację wszystkich pozycji. Liczenie PZ aktualizuje tylko prezentację policzonych ilości. Wyłącznie potwierdzony wynik operacji WMS może rozliczyć received/posted w PO.
Zdarzenia po commit, deduplikacja przez ID zdarzenia i operacji. Nieznany wynik utrzymuje zajęty limit do uzgodnienia. Anulowanie ASN zwalnia wyłącznie nierozliczoną i bezpieczną część zobowiązania.
Potwierdzone odwrócenie przyjęcia obniża postedNet tylko raz, z odniesieniem do pierwotnego charge. Zgodnie z WM22: otwarta ASN odzyskuje ilość w outstanding; zamknięta/anulowana ASN oddaje ją do wolnej ilości PO, bez automatycznego otwierania ASN. PO przestaje być w pełni przyjęte, a zamknięte PO wymaga jawnego ponownego rozliczenia. Cofnięcie jest dopuszczalne tylko według ograniczeń rzeczywistego WMS; edycja statusu nie stanowi odwrócenia ruchu. Dokładne przejścia i self-contained test potwierdzonego reversal należą do specyfikacji etapu 2.

N/A dla nowych harmonogramów, e-maili, integracji EDI i osobnego silnika workflow w tej propozycji. Recovery postingu ma używać kontraktu operacji magazynowych, nie nowego mechanizmu w zakupach.

## Security, Privacy, and Compliance

Każdy odczyt i zapis jest scoped tenant+organization, także sprawdzanie dostawcy i limitu PO. Brak zakresu nie rozszerza widoczności. ACL sprawdzane na serwerze, z obsługą wildcard przez framework. Usunięcie/przejście stanu wymaga uprawnienia i wersji. Cena zakupu nie trafia do odpowiedzi Panelu magazyniera.
Historia rewizji zapisuje kto/kiedy/co i powód korekty; nie loguje całych payloadów kontaktowych. Snapshot dostawcy ma minimalny potrzebny zestaw danych i podlega mechanizmom szyfrowania frameworka. Nie osłabiać audytu, blokad, idempotencji i zasad starego PZ.

## Integration Coverage

Plan walidacji (testy nie były uruchamiane, bo nie ma implementacji):

| Test | Samodzielny scenariusz i oracle |
|---|---|
| TEST-001 | Tenant, kupiec, aktywny dostawca, produkt i magazyn; utwórz PO bez PR, edytuj, zatwierdź; wartości po reload zgodne, globalna lista pokazuje te same pozycje |
| TEST-002 | Brak adaptera dostawców: szkic zachowany, release odmówiony; po zmianie nazwy dostawcy snapshot zatwierdzonego PO nie zmienia się |
| TEST-003 | Drugi tenant i użytkownik bez feature: lista/picker/GET/update/release nie ujawniają danych; dwie edycje tego samego PO dają 409 dla nieaktualnej wersji |
| TEST-004 | PO100; dwa równoległe ASN60: co najwyżej jedno potwierdzone60, drugi 409; inny dostawca/magazyn blokowany |
| TEST-005 | PO100/ASN60; policz55 bez postingu: posted=0 i zobowiązanie60; potwierdzony posting55: posted55/outstanding5/free40; rozliczenie niedoboru zwalnia5 i daje free45 |
| TEST-006 | Ten sam wariant na dwóch PO; wynik liczenia ma jawny podział po źródłach; suma podziałów równa wynikowi; brak automatycznego dopasowania po SKU |
| TEST-007 | Powtórzenie release/utworzenia PZ/postingu nie duplikuje skutków; UNKNOWN nie uwalnia limitu; anulowanie poniżej posted+pending+outstanding blokowane |
| TEST-008 | Każdy nowy ekran: create→save→reload, filtry/paginacja, loading/empty/error/403/409, zachowany formularz po błędzie, klawiatura, focus, narrow width, light/dark |

## Implementation Phases

Dwa etapy produktowe, zgodnie z decyzją użytkownika. Każdy ma osobny dokument wykonawczy oparty na odpowiedniej istniejącej specyfikacji WM22.

### Etap 1 — zamówienia zakupu i pozycje

Zależności: uzgodniony interfejs kartoteki dostawców; pełne uruchomienie wymaga działającego wyboru dostawcy. Wartość: samodzielna ewidencja zamówień bez PR.
1. Opisać i uzgodnić adapter dostawcy, numerację, pola PO/pozycji, rewizje, scope oraz ACL; opracować migrację bez jej stosowania.
2. Dostarczyć działający pion szkicu: zapis/odczyt/edycja/usunięcie, lista i formularz, pozycje oraz TEST-001/002/003/008. Bez dostawców dostępne tylko szkice.
3. Dodać zatwierdzanie, korekty i anulowanie oraz widok zbiorczy pozycji. Ukryć akcję Utwórz awizację, zakładki Awizacje/Przyjęcia i kolumny awizowano/policzono/zaksięgowano/wolne do awizacji do aktywacji etapu 2. Etap 1 pokazuje zamówione/anulowane ilości i terminy; nie prezentuje zer jako dowodu braku przyjęć.
Exit: kupiec tworzy PO bez PR, zatwierdza je z aktywnym dostawcą i śledzi pozycje w obu widokach. REQ-001/002/003/006, AC-001/002/006. Testy i pełny gate zielone. Same szkice przy niedostępnym module dostawców nie zamykają etapu.

### Etap 2 — awizacje z powiązaniem przyjęcia

Zależności: zamknięty etap 1 oraz uzgodnione granice rozdzielenia Awizo/PZ i działający, zweryfikowany przepływ postingu WMS. Ten przepływ jest osobną zależnością prac nad przyjęciem, nie funkcją dostarczaną przez sam moduł zakupów/awizacji. Obecne PZ go nie zapewnia. Jeżeli nie został dostarczony w tych pracach, etap 2 nie osiąga pełnego odbioru; samo uzgodnienie interfejsu nie wystarcza. Nie rozpoczynać od dublowania istniejącego PZ. Wartość: kontrolowana dostawa i jednoznaczna realizacja PO.
1. Dostarczyć pion awizacji: listę, formularz, źródłowe pozycje i limit rezerwowany przez procurements; testy TEST-003/004/007/008.
2. Powiązać przyjęcie z pozycjami ASN, zachować obecne liczenie i wprowadzić jawne przypisanie ilości źródłowych; TEST-005/006.
3. Włączyć potwierdzone rozliczenie, częściowe dostawy i decyzję o niedoborze, kontrolowane korekty oraz recovery istniejącej operacji; TEST-005/007. Bez potwierdzonego postingu nie wyświetlać PO jako przyjętego i nie zamykać etapu.
Exit: PO100/ASN60/przyjęcie55 ma prawidłowe osobne ilości; brak podwójnej awizacji i postingu; zachowane lineage PZ; REQ-004/005/006, AC-003/004/005/006.

Walidacja implementacji dla każdego etapu: yarn generate && yarn typecheck && yarn lint && yarn ds:check && yarn test && yarn build; integracje yarn test:integration:ephemeral. Bez migracji produkcyjnej do walidacji. Testy będą przypisane do rzeczywistych API/UI w specyfikacjach wykonawczych. TEST-007 obejmuje także podwójne dostarczenie reversal i zwrot limitu według stanu ASN.

## Requirement Traceability

| REQ | Ścieżka | Etap | Test | Kryterium |
|---|---|---|---|---|
| 001 | J-001 / PO | 1 | 001,003 | AC-001 |
| 002 | J-002 / pozycje | 1 | 001,008 | AC-002 |
| 003 | J-001 / dostawca | 1 | 002,003 | AC-006 |
| 004 | J-003 / ASN | 2 | 004,007 | AC-003 |
| 005 | J-004/005 / przyjęcie | 2 | 005,006,007 | AC-004/005 |
| 006 | Wszystkie ekrany | 1 i 2 | 003,008 | AC-006 |

Identyfikacja exact example source i odrębnego testu dla każdej trasy/rozszerzenia należy do dwóch specyfikacji wykonawczych. Nie ustalono nowych discovery seams w tej propozycji; brak macierzy wykonawczej nie uprawnia do rozpoczęcia kodowania.

## Rollout, Migration, and Rollback

Włączyć etap 1 dopiero po sprawdzeniu dostawców i uprawnień; etap 2 po jego własnym odbiorze. Stare PZ zachowują historię i możliwość odczytu. Nie przypisywać starych supplierName do dostawców automatycznie po nazwie i nie tworzyć fikcyjnych powiązań PO dla starego PZ.
Migracje generowane yarn db:generate, SQL/snapshot do przeglądu, zastosowanie wymaga osobnej zgody. Wycofanie UI blokuje nowe operacje, nie usuwa dokumentów, rezerwacji ani potwierdzonych ruchów. Operacje w toku muszą być rozliczone. Cofnięcie skutku magazynowego wyłącznie przez dozwoloną korektę WMS; nie przez zmianę statusu PO.

## Risks and Tradeoffs

| Ryzyko | Odpowiedź |
|---|---|
| Moduł dostawców powstanie później | Szkice z nazwą, release zablokowany; nie dublować kartoteki; pełny odbiór etapu 1 zależy od pickera |
| Trwające zmiany Awizo/PZ | Przed wdrożeniem ustalić jednego właściciela awizacji i adaptować już przyjęty podział |
| Ten sam SKU w kilku PO | Jawne przypisanie ilości po źródłowej pozycji, nie heurystyka SKU |
| Równoległe awizacje | Jeden właściciel limitu i atomowa rezerwacja, 409, bez cichego przycinania |
| Counted mylone z posted | Osobne kolumny i akcje; tylko potwierdzony ruch rozlicza PO |
| Nieznany wynik operacji | Stan wyjaśniania, zachowany limit, ponowienie tej samej operacji |
| Zmiana historycznego dostawcy/ceny | Snapshot i rewizja; bez przeliczania starego przyjęcia |
| Duże listy pozycji | Serwerowe filtrowanie i paginacja, indeksy scoped; brak ładowania całej bazy |
| Nadmiar funkcji WM22 | PR, KJ, Android, podatki i rozbudowane procesy poza tym zakresem |

## Acceptance Criteria

- AC-001: PO można utworzyć i zatwierdzić bez PR; edycja szkicu i kontrolowane rewizje działają z blokadą wersji.
- AC-002: Pozycje w PO i liście zbiorczej mają identyczne ID i wartości, a filtr terminu wskazuje zaległe pozycje.
- AC-003: Dwa ASN60 na PO100 nie rezerwują łącznie120; mieszani dostawcy/magazyny są blokowani.
- AC-004: Policzenie55 nie zwiększa posted; potwierdzone przyjęcie55 i rozliczenie niedoboru dają opisane limity.
- AC-005: Dwa źródła tego samego SKU są rozliczone osobno, idempotentnie i z historią; replay nie podwaja ruchu.
- AC-006: Dostawca i snapshot są obsługiwane bez drugiej kartoteki; brak scope/uprawnień/aktualnej wersji blokuje zmianę; UI spełnia TEST-008.
Są to kryteria przyszłej implementacji, nie twierdzenia o obecnym działaniu aplikacji.

## Final Compliance Report

| Sprawdzenie | Wynik | Dowód / ograniczenie |
|---|---|---|
| Zakres użytkownika | pass | Dwa etapy, PO bez PR, osobny przyszły moduł dostawców |
| Rozdział obecnego kodu i zamiaru | pass | WM22 dokumentacyjne; PZ liczy bez postingu |
| Wzorzec UI | pass | Inspekcja sales 0.8.0 i backend-ui; makiety tekstowe, bez browser QA |
| Powiązania ilości i scenariusze | pass | Formuły, TEST-004..007, źródłowa pozycja |
| Plan i kryteria odbioru | pass | Dwa etapy i macierz REQ/TEST/AC |
| Gotowe kontrakty wykonawcze i zgoda na implementację | fail | Niezlecone; potrzebne interfejs dostawców, podział Awizo/PZ, istniejący posting i dokładna macierz seams/testów |

Blocked — rozpoczęcie implementacji wymaga dwóch specyfikacji wykonawczych z ustalonymi kontraktami i zgody użytkownika na implementację. Niezależny przegląd spójności zakresu: pass po doprecyzowaniu zależności postingu, UI etapu 1 i odwróceń. Zadanie przygotowania propozycji funkcjonalnej jest zakończone; nie wymaga kolejnej decyzji użytkownika na tym etapie.

## Open Questions

Brak otwartych pytań blokujących propozycję. Q1: dwa etapy; Q2: PO bez PR — odpowiedzi użytkownika 2026-09-19.
Zależności do rozwiązania przy osobno zleconym wdrożeniu: dokładny interfejs powstającego modułu dostawców oraz kontrakt połączenia z rozwijanym Awizo/PZ i postingiem. Nie zastępujemy ich wymyślonymi API.

## Changelog

2026-09-19: inspekcja WM22/PZ/sales i szkielet propozycji. Następnie odpowiedzi użytkownika: dwa etapy, PO bez PR; uzupełniono propozycję, ekrany, reguły i plan odbioru. Brak implementacji i zmian w repozytorium WM22.

2026-09-19: na polecenie użytkownika wdrożono etap 1 jako moduł `procurements`. Zrealizowano: encje `PurchaseOrder`/`PurchaseOrderLine` z migracją i snapshotem, komendy create/update/delete (z undo/redo i blokadą optymistyczną) oraz release/withdraw/cancel, trasy `/api/procurements/purchase-orders` (+ `/release`, `/withdraw`, `/cancel`) i `/api/procurements/purchase-order-lines`, zdarzenia CRUD i lifecycle, ACL/setup, ekrany `/backend/purchases/orders` (lista, nowy, szczegóły, edycja) i `/backend/purchases/order-lines`, lokalizacja PL/EN.

Odstępstwa od propozycji w etapie 1, z uzasadnieniem: (1) statusy ograniczono do `draft`/`released`/`cancelled` — `PARTIALLY_RECEIVED`/`RECEIVED`/`CLOSED` zależą od potwierdzonego postingu z etapu 2, więc pokazywanie ich teraz byłoby statusem, którego nic nie potrafi ustawić; (2) korekta zatwierdzonego PO odbywa się przez `withdraw` do szkicu, a nie przez osobny mechanizm rewizji — `PurchaseOrderRevision` czeka na etap 2, bo dopiero zobowiązania awizacji czynią rewizję konieczną; (3) nie ma kolumn „anulowano/awizowano/policzono/zaksięgowano” ani osobnej `quantity_cancelled`: etap 1 nie umie ich wypełnić, a zera udawałyby dowód braku przyjęć; (4) dostawca to nadal wpisywana nazwa plus `supplier_id` (null) i snapshot brany przy zatwierdzeniu — kartoteka to issue #51, a pełny odbiór etapu 1 wymaga jej pickera.
