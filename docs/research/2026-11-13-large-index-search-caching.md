# Find Everything: Suchindex und Caching bei rund 68 Millionen Pfaden

Stand: 13.11.2026 · ResearchX · Quellcodebasis [f17a18e](https://github.com/Supersynergy/find-everything/tree/f17a18ef676f620f8953385578e6fa558e191532), Version 0.3.7.

**Die erste Priorität sind präzisere Cache-Schlüssel und weniger unnötige Invalidierungen. Für die erste Suche nach kurzen Teilzeichenfolgen braucht es zusätzlich einen passenden Index.** Empfohlen sind anschließend Bigramm-Postings mit komprimierten ID-Mengen und eine getrennte Verarbeitung von interaktiven Treffern und vollständigen Zählungen. Alle folgenden Anwendungen und Zielwerte sind Vorschläge. Diese Recherche enthält keine neuen Leistungsmessungen, keinen Umbau und keinen neuen Vollscan.

Der zuletzt vollständig aufgebaute Basissnapshot umfasste 68.427.651 Pfade; der spätere Testsnapshot mit Live-Änderungen 68.471.992. Seine vorbereitete Suchdatenbank war rund 28 GB groß. Die bisherige installierte Version lieferte für `ne` eine Vorschau in 1.191 ms über eine isolierte API auf einer konsistenten APFS-Kopie. Die vollständige Zählung überschritt zuvor 10 Sekunden. Das sind frühere Komponentenbeobachtungen, keine Verteilungen und keine Messung der nativen Bedienung. Siehe [bestehende Benchmarks](../BENCHMARKS-2026-11-13.md). Beim bisherigen Installationscheck verlangte ein Journalhinweis einen expliziten Abgleich; Cache-Treffer beweisen keine aktuelle Vollständigkeit.

Im Code sind mehrere Ansatzpunkte belegt:

| Befund | Folge |
| --- | --- |
| API-Cache: 5 Minuten, 256 Einträge, 16 MiB; Antworten über 256 KiB werden nicht aufgenommen. | Große Seiten können trotz freiem Gesamtbudget jedes Mal neu berechnet werden. |
| Schlüssel enthalten die Dateisignatur der gemeinsamen Live-Datenbank. | Eine Änderung eines unabhängigen Indexbereichs kann andere Such-Caches unbrauchbar machen. |
| Der Schlüssel wird vor der Reader-Vorbereitung mit Synchronisierung berechnet. | Ändert die Vorbereitung den Snapshot, kann das Ergebnis unter einem bereits veralteten Schlüssel landen; aus dem Ablauf abgeleitet, noch nicht quantifiziert. |
| Jede Änderung an `propertiesRevision` leert auch Verzeichniszähler, Kandidatenmengen, Zählungen und FTS-Planentscheidungen. | Eine Metadatenergänzung verwirft wiederverwendbare Arbeit für reine Namenssuchen. |
| Gemeinsamer Reader mit höchstens zwei aktiven/eingereihten Aufträgen; kein Zusammenlegen identischer laufender Cache-Misses. | Langsame vollständige Suchen und doppelte Anfragen können interaktive Arbeit verdrängen. |

Belege: [API-Cache und Vorbereitung](https://github.com/Supersynergy/find-everything/blob/f17a18ef676f620f8953385578e6fa558e191532/src/services.ts#L114), [Reader-Invalidierung](https://github.com/Supersynergy/find-everything/blob/f17a18ef676f620f8953385578e6fa558e191532/src/path-search.ts#L378), [Warteschlange](https://github.com/Supersynergy/find-everything/blob/f17a18ef676f620f8953385578e6fa558e191532/src/search-process.ts#L50). Die aktuelle Antwortaufbereitung berechnet Journalzustand und Warnungen bei jedem Zugriff neu; dieses Verhalten muss erhalten bleiben.

1. **R1 · P0: Cache nach tatsächlichen Abhängigkeiten aufteilen.** Das Vorbild ist die lokale Gültigkeit von Cache-Einträgen, etwa pro Segment im [Elasticsearch Query Cache](https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/node-query-cache-settings). Für Find Everything ist mein Vorschlag: pro Indexbereich getrennte Revisionen für Namensbestand, Metadaten und weitere Suchquellen. Ein Name-ohne-Filter-Prädikat hängt nicht von Dateigrößen ab; eine Größensuche schon.

   Drei Ebenen getrennt halten: vollständige passende IDs, geordnete Seiten dieser IDs und aktuell nachgeladene Eigenschaften. Zählungen gehören zum Prädikat und Bestand, nicht zur Seitennummer. Sortierung, Lernboosts, Favoriten und zeitabhängige Filter bringen jeweils ihre echten Abhängigkeiten mit. Der Schlüssel muss an den tatsächlich gelesenen Snapshot gebunden werden, nachdem die notwendige Synchronisierung geklärt ist.

   Parserbasierte Normalisierung kann semantisch gleiche Anfragen zusammenführen. Groß-/Kleinschreibung, zitierte Leerzeichen, Unicode und Reihenfolge bedeutungstragender Elemente dürfen sich dabei nicht ändern. Gleiche gleichzeitig laufende Anfragen lassen sich nach dem [SingleFlight-Prinzip](https://pkg.go.dev/golang.org/x/sync/singleflight) teilen. Jeder wartende Aufrufer braucht eigenes Abbruchverhalten; ein Abbruch darf anderen Nutzern nicht die gemeinsame Berechnung entziehen.

   **Pilot:** dieselbe Namenssuche über Metadatenänderungen und fremde Bereichsänderungen hinweg wiederverwenden; bei Umbenennung korrekt invalidieren. Zwei gleiche parallele Anfragen führen genau eine Berechnung aus. Frische Eigenschaften und Warnungen bleiben korrekt. Lizenz/Umfang: eigene Implementierung im vorhandenen TypeScript/SQLite; keine zusätzliche Bibliothek nötig. Gewinn bislang ungemessen.

2. **R2 · P1: Kurze Infixsuchen mit Bigrammen und komprimierten Mengen indexieren.** [SQLite FTS5](https://www.sqlite.org/fts5.html#the_trigram_tokenizer) indexiert mit dem Trigramm-Tokenizer drei Unicode-Zeichen. Kürzere MATCH-Suchen liefern darüber keine Treffer; LIKE/GLOB kann ohne geeignete Dreierfolge scannen. Der aktuelle Präfix-Schnellpfad hilft bestimmten Anfangstreffern, löst aber nicht die beliebige Zweizeichenfolge in einem Dateinamen oder Verzeichnis.

   Vorschlag: zwei Zeichen über Bigramm-Postings, längere Begriffe über geeignete Trigramm-Postings, ein Zeichen über eine ausdrücklich unterstützte separate Route. [CRoaring](https://github.com/RoaringBitmap/CRoaring) bietet komprimierte Integer-Mengen und [Operationen zur Kardinalität](https://github.com/RoaringBitmap/CRoaring/blob/master/include/roaring/roaring.h). Damit können vollständige verifizierte Treffermengen für weitere Filter und Zählungen wiederverwendet werden.

   **Kandidaten sind noch keine exakten Treffer.** Gram-Schnittmengen brauchen die abschließende Suchprüfung. Erst die geprüfte ID-Menge liefert eine exakte Gesamtzahl. Dateiname und passende Verzeichnisse müssen vereinigt werden, ohne Doppelzählung; Änderungen und gelöschte Unterbäume müssen die Mengen korrekt aktualisieren. Für Tippen und Verfeinern darf niemals nur die bisher sichtbare Seite als vollständige Ausgangsmenge dienen.

   [plocate](https://plocate.sesse.net/) und [Zoekts Entwurf](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md) sind passende Designreferenzen. plocate verwendet Byte-Trigramme; laut [Handbuch](https://plocate.sesse.net/plocate.1.html) bleiben sehr kurze Suchbegriffe ein Scan-Fall. Linux-I/O und fremde Demonstrationszeiten sind kein macOS-Benchmark. Zoekts Positionsdaten für Code-Suche können für reine Pfadnamen überdimensioniert sein.

   **Pilot:** eingefrorene 100.000/1 Mio./5 Mio. Pfade, danach derselbe volle Snapshot. Exakte IDs, Zahlen und Reihenfolge gegen eine Referenz prüfen: `ne` in `one.txt`, Verzeichnistreffer, NFC/NFD, Smart Case, Zeilenumbrüche im Pfad und Umbenennungen. Indexgröße und Aufbauzeit mitmessen: häufige Bigramme können riesige Listen erzeugen. Lizenzen: CRoaring wahlweise Apache-2.0 oder MIT; Zoekt Apache-2.0. plocate hat GPL-2.0-Quellcode und dient hier als Entwurfsreferenz; kein Code wurde übernommen.

3. **R3 · P1: Erste Treffer, vollständige Zählung und tiefe Seiten getrennt planen.** Die [Elasticsearch-Suchdokumentation](https://www.elastic.co/docs/solutions/search/the-search-api) unterscheidet exakte Zahlen von unteren Grenzen und beschreibt den zusätzlichen Aufwand exakter Zählungen. Übertragbare Anwendung: ein begrenzter, nachrangiger Zählpfad neben dem interaktiven Reader. Veraltete Suchgenerationen abbrechen; vollständige Zählungen erst nach kurzer Tipp-Pause starten und nach gültiger Bestandsrevision wiederverwenden.

   Die Vorschau muss ihre zugesicherte Rangfolge einhalten. Die Oberfläche darf „1.000 angezeigt, Gesamtzahl wird ermittelt“ melden; eine begrenzte Menge darf nicht als vollständige Zahl erscheinen. Tiefe Seiten könnten mit [SQLite-Zeilenwerten](https://www.sqlite.org/rowvalue.html#scrolling_window_queries) über den letzten Sortierschlüssel und die ID fortgesetzt werden. Der Cursor enthält den Snapshot; ein Sprung ans Ende benötigt weiterhin eine genaue Zahl beziehungsweise passende Rangstruktur.

   **Pilot:** eine langsame Zählung läuft, während neue Eingaben eintreffen. Erste passende Seite, Abbruchverhalten, exakte spätere Zahl und komplette Seitenfolge gegen die Referenz prüfen. Mehrere Reader nur mit gemessenen CPU-/RAM-Grenzen einsetzen. Lizenz: eigene TypeScript-Planung, vorhandenes SQLite als Public Domain. Kein neuer Server erforderlich.

4. **R4 · P2: Statische Ranganteile vorberechnen und Namen verdichten.** Derzeit entstehen Ranganteile durch wiederholte SQL-Ausdrücke über Endungen. Eine gespeicherte Typpriorität mit passendem Index kann diese Arbeit verlagern. [SQLite-Ausdrucksindizes](https://www.sqlite.org/expridx.html) verlangen passende deterministische Ausdrücke. Lernboosts und dynamische lexikalische Stufen bleiben gesondert zu berücksichtigen; ein statischer Index allein garantiert noch keine korrekte globale Rangfolge.

   Zusätzlich lohnt eine Messung, wie oft normalisierte Dateinamen wiederkehren. Ein Wörterbuch mit Vorkommenslisten könnte wiederholte Zeichenketten einsparen. [fst](https://github.com/BurntSushi/fst) ist eine kompakte, per mmap nutzbare Struktur für geordnete Wörterbücher und Präfixe. Beliebige Infixsuche braucht weiterhin die Gram-Struktur. Der tatsächliche Wiederholungsfaktor dieses Bestands wurde nicht gemessen.

   **Pilot:** Query-Plan, Indexbytes, Aufbauzeit und Seitenlatenz vergleichen; dieselben Ranggrenzen und Lernboosts exakt reproduzieren. Erst Stichprobe, dann Schemaänderung. Lizenz: SQLite Public Domain; fst wahlweise MIT oder Unlicense.

5. **R5 · P2: Unveränderliche Basis, kleines Änderungsdelta, feste Lesesnapshots.** [Tantivy](https://github.com/quickwit-oss/tantivy/blob/main/ARCHITECTURE.md) beschreibt unveränderliche Suchsnapshots, Segmente und spaltenorientierte Felder. Übertragbare Anwendung: die große Basis nur lesen, neue/entfernte IDs in einem kleinen Delta führen und einen neuen konsistenten Stand atomar veröffentlichen. Zusammenführungen müssen zeitlich und nach Speicher begrenzt sein. Jeder Cursor und Cache bindet sich an diesen Stand.

   Ein kleinerer Zwischenschritt könnte dauerhafter [SQLite-WAL-Betrieb](https://www.sqlite.org/wal.html) sein. Aktuell wird der veröffentlichte Suchindex in DELETE-Modus gebracht. WAL erlaubt parallele Leser und einen Writer, verlangt aber eigene Checkpoint-Grenzen und kohärente Sicherung. Ein Cache nur nach Hauptdatei-mtime wäre dann ungeeignet. Lange Leser können Checkpoints behindern. Der hier geprüfte Bun-Runtime meldet SQLite 3.43.2; vor einem WAL-Piloten sind Patchstand und die aktuell dokumentierten WAL-Reset-Korrekturen zu prüfen. Daraus folgt ohne Prüfung der Herstellerpatches keine Aussage über eine konkrete installierte Schwachstelle.

   Der gemeldete Journalwechsel betrifft außerdem die Frische. [Apples FSEvents-Dokumentation](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html) verlangt geeigneten Abgleich nach verlorenen Ereignissen oder Root-Änderungen; Ereignisstände gehören zum jeweiligen Datenträger. [Watchman-Clocks](https://facebook.github.io/watchman/docs/clockspec) zeigen, warum eine logische Änderungsmarke einem bloßen Zeitstempel vorzuziehen ist. Ein schneller Cache darf eine bestehende Lücke nicht als aktuellen Bestand ausgeben.

   **Pilot:** Schreiben während Suche, Umbenennung, Unterbaum-Löschung, Neustart und Datenträger-/Journalwechsel. Keine gemischten Revisionen; verständliche Frischezustände; begrenzte Schreibpausen, WAL-/Delta-Größe und Zusammenführungsdauer. Lizenzen: Tantivy MIT als Referenz, SQLite Public Domain; Apple/Watchman nur Dokumentationsreferenzen.

6. **R6 · P3: Verdrängungsstrategie erst anhand echter Such-Traces auswählen.** [Caffeine](https://github.com/ben-manes/caffeine/wiki/Design) ist die Referenz für Window TinyLFU; [S3-FIFO](https://s3fifo.com/blog/2023/08/01/fifo-queues-are-all-you-need-for-cache-eviction/) und [SIEVE](https://www.usenix.org/conference/nsdi24/presentation/zhang-yazhuo) sind weitere Kandidaten. Möglicher Nutzen hier: kurzlebige einmalige Tipp-Präfixe sollen teure wiederverwendbare Zählungen oder ID-Mengen nicht verdrängen. Die publizierten Trace-Ergebnisse bestimmen keinen Gewinner für diese App.

   **Pilot:** denselben anonymisierten Tipp-/Seiten-/Änderungs-Trace mit LRU und den drei Kandidaten abspielen, jeweils mit 128 MiB, 512 MiB und 2 GiB Budget. Byte-Trefferrate, vermiedene Rechenzeit, p95, Einmalzugriffe und Verwaltungsaufwand ausweisen. Cache-Schichten getrennt bilanzieren. Ein 2-GiB-mmap-Limit ist kein Beleg für 2 GiB residenten RAM; der vorhandene Reader nutzt daneben einen 64-MiB-SQLite-Seitencache.

   Lizenzen: Caffeine ist eine Java-Bibliothek unter Apache-2.0 und dient als Vorlage. Bei S3-FIFO/SIEVE wurde keine einzubauende Implementierung ausgewählt. [libCacheSim](https://github.com/cachemon/libCacheSim) ist ein optionales GPL-3.0-Auswertungswerkzeug, keine vorgeschlagene Laufzeitabhängigkeit.

7. **R7 · P3: Tantivy nur als begrenzten Backend-Vergleich prüfen.** Falls die vorherigen Piloten einen erheblichen Restengpass zeigen, ist Tantivy unter MIT ein sinnvoller Vergleich. Sein [N-Gramm-Tokenizer](https://github.com/quickwit-oss/tantivy/blob/main/src/tokenizer/ngram_tokenizer.rs) erlaubt passende Teilzeichenfolgen. Die bestehende Suchsprache, Unicode-/Case-Semantik, Rangfolge, Filter, Live-Änderungen und Vollständigkeit entstehen dadurch noch nicht.

   **Pilot:** identischer eingefrorener Bestand, identischer Abfrage-/Änderungstrace und identische Ergebnisreferenz wie bei SQLite. Gesamten RAM, Datenträgerbedarf, Aufbauzeit sowie erste Seite und vollständige Zählung vergleichen. Ein Komplettwechsel wird durch diese Recherche nicht begründet.

Für die Umsetzung ist **R1 der kleinste vollständige erste Schritt**. Er kann unnötige Wiederholungen und doppelte Arbeit reduzieren, ohne ein neues Suchbackend einzuführen. Neue einmalige Kurzsuchen bleiben anschließend ein eigener Index-Pilot nach R2. Mehr Cache-RAM allein löst diesen Fall nicht.

Der gemeinsame Benchmarkplan verwendet gespeicherte Pfadlisten statt wiederholter Vollscans. Hyperfine eignet sich für feste CLI-/SQL-Komponenten; API- und native Latenzen brauchen zusätzlich einen reproduzierbaren Eingabetrace. Prozessstart, Warteschlange, Synchronisierung, Reader-Zeit und UI-Verzögerung getrennt ausweisen. Prozess-kalt und Betriebssystem-Dateicache-kalt sind unterschiedliche Bedingungen; kein globales Cache-Leeren.

Verbindliche Genauigkeit: **0 verlorene Treffer**, gleiche exakte Zahlen und zugesicherte Reihenfolge. Versteckte und generierte Dateien bleiben enthalten. Abdecken: kurze und häufige Begriffe, Verzeichnistreffer, Filter, tiefe Seiten, drei gespeicherte Suchbereiche, parallele Clients, Metadatenänderungen sowie Hinzufügen/Löschen/Umbenennen und Journalwechsel. Als erst zu prüfende Zielwerte bieten sich warme erste Seiten p95 unter 250 ms und gültige gecachte Zählungen unter 50 ms an; diese Ziele sind bislang nicht erreicht oder nachgewiesen.

Die sechs ResearchX-Kanäle wurden geprüft:

| Kanal | Ergebnis und Grenze |
| --- | --- |
| ghmax | 12 erste Treffer plus gezielte Kardinalitätssuche; relevante Kandidaten bis zu Zoekt, plocate und CRoaring im Original verfolgt. |
| GitStars | 50 Repositories im 7-Tage-Feed geprüft; kein überzeugender zusätzlicher Dateisuch-Donor. Trendfeed ist kein vollständiger Themenindex. |
| spd | Top 3 ohne passenden lokalen Codekorpus; unpassende UI-/i18n-Vorschläge verworfen. |
| metacode | Standard-SaaS-Plan verworfen; gezielte Komponentenabfrage lieferte SQLite/Tantivy. Leere Live-Suche beweist keine Abwesenheit. |
| superweb | 20 Ergebnisse aus 40 Kandidaten; 81 Engines versucht, nicht 81 erfolgreich. Blockaden/Timeouts im Rohbeleg erhalten; entscheidende Aussagen anhand Primärquellen geprüft. |
| YouTube-Service | Konfiguriertes `GET /api/v1/trending` auf localhost:8080 verweigerte die Verbindung, curl Exit 7. Dienst nicht gestartet; keine Videos oder Transkripte ausgewertet. |

Rohbelege, Quellenmanifest und Prüfskript liegen lokal in `.git/researchx-20261113/`. Die Dokumentprüfung kontrolliert Kanalabdeckung, Quellenbezug, Einschränkungen und Änderungsumfang. Sie beweist weder die Geschwindigkeit noch die vollständige Korrektheit eines noch nicht gebauten Piloten.
