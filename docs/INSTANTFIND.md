# Instantfind für Dokumente und Projektdateien

`meaning:"…"` sucht nach der Bedeutung einer Beschreibung. Die vorhandene
Dateinamen-/Pfadsuche, wörtliche `content:`-Suche und CLAP-Audiosuche bleiben erhalten.
Der neue Weg ist optional und funktioniert im Suchfeld der App, über CLI und API.

## Lokale Vorbereitung

Es werden keine Bibliotheken oder Modellgewichte automatisch heruntergeladen.
Die erste Einrichtung benötigt einen lokalen ONNX-Gemma-Q4-Export und eine
Python-Umgebung mit `numpy` und `onnxruntime`. Die Einrichtung erstellt aus dem
gepinnten Tokenizer eine private SQLite-Tabelle für Vokabular und BPE-Regeln.
Bereits eingerichtete alte Modelle funktionieren weiter; erneutes `setup` aktiviert
die sparsame Variante. Die Modellgewichte und vorhandenen Dokumentvektoren bleiben
kompatibel. Es wird nichts trainiert.

```sh
fe instantfind setup --model /ABSOLUTER/PFAD/ZUM/MODELL --python /ABSOLUTER/PFAD/ZU/python
fe content index --index MEIN-PROJEKT --max-files 500 --seconds 60
fe instantfind index --index MEIN-PROJEKT --max-files 500 --seconds 60
fe instantfind status --index MEIN-PROJEKT
```

`MEIN-PROJEKT` ist ein vorhandener, bewusst gewählter Index. Die Einrichtung prüft
den gepinnten Export per SHA-256 und kopiert ihn in den privaten App-Support-Ordner.
Die Modellgewichte unterliegen der Gemma-Lizenz und sind nicht im App-Bundle enthalten.

Die Textvorbereitung verwendet den bestehenden begrenzten Extraktor. Unterstützt
werden Text-/Projektdateien, extrahierbare PDFs und unter macOS Office/RTF. Kein OCR.
Ein Budgetende liefert `pending:true`; derselbe Befehl setzt den Aufbau fort.
Ein vollständiger alter Vektorindex bleibt bis zum fertigen Austausch erhalten.

## Suchen

```sh
fe search 'meaning:"Wie nehme ich eine fehlerhafte Auslieferung zurück?" ext:md' --index MEIN-PROJEKT --json
fe search 'meaning:"recover edits made without a network connection"' --index MEIN-PROJEKT --json
```

Im App-Suchfeld dieselbe `meaning:`-Syntax eingeben und den vorbereiteten Index
auswählen. Dateityp, Pfad, Datum, Größe, Favoriten und Auslassungen bleiben harte
Filter. Eine explizite Sortierung wird beachtet. `content:` und Audiobedingungen
können nicht mit `meaning:` kombiniert werden.

Der Suchlauf liest keine Dokumentinhalte nach. Er vergleicht vorberechnete Vektoren
und prüft die Dateimetadaten vor sowie nach der Inferenz. Veränderte, entfernte und
gefilterte Dateien werden nicht ausgegeben. Nach Änderungen den Text- und danach
den Bedeutungsindex explizit aktualisieren. `--fresh` löst keine versteckte Extraktion aus.

## Grenzen und Betrieb

- Vorerst maximal 10.000 ausgewählte Dokumente je Bedeutungsindex, standardmäßig 500.
- Pro Dokument höchstens sechs überlappende Abschnitte aus den ersten 6.000 Zeichen.
  Jeder Modelltext ist auf 256 Tokens begrenzt. Spätere Passagen können fehlen.
- Ergebnisse sind angenäherte Relevanztreffer. `complete:false`, Abdeckung und
  Grenzen bleiben sichtbar; kein Vollständigkeitsbeweis für das Dateisystem.
- Das Modell läuft lokal mit zwei CPU-Threads. Der Suchprozess hält es während
  seiner Lebensdauer wiederverwendbar; es gibt keinen zusätzlichen Systemdienst.
- Nach einer erfolgreichen Bedeutungsanfrage bleibt der bestehende Suchprozess
  einschließlich Modell bis zum Ende des Dienstes erhalten. Reine Dateisuchen
  behalten ihre zehnminütige Leerlaufgrenze. Nach App-Neustart, Absturz oder Abbruch
  eines laufenden Suchprozesses muss das Modell erneut geladen werden.
- Für große Gesamtindizes ist dies keine Anweisung, jeden Pfad einzubetten.
  Bereiche gezielt auswählen; Millionenvektoren benötigen einen anderen Indexplan.

`fe instantfind clear --index MEIN-PROJEKT` entfernt nur den Bedeutungsindex und
seinen Aufbau-Checkpoint. Dateien, Pfadindex und Textcache bleiben erhalten.

## Neue Vergleichsaufgaben

Der Benchmark verwendet 30 synthetische, realistisch benannte Dokumente und
Projektdateien. Je Dokument gibt es eine neue deutsche und englische Frage.
Fragen, Erwartungsdateien und Korpus wurden vor dem ersten Modelllauf eingefroren.
Keine Testfrage wurde ins Training oder in die eingebetteten Dokumente übernommen.

```sh
bun scripts/bench-instantfind.ts prepare
bun scripts/bench-instantfind.ts baseline
bun scripts/bench-instantfind.ts meaning
```

Die Datei-/Pfadsuche und wörtliche Inhaltssuche werden mit unveränderten Fragen
gemessen. Zusätzlich gibt es eine stärkere Kontroll-Baseline: klassische
FTS-Wortsuche mit OR-Verknüpfung und vorab festgelegten Stoppwörtern. Diese letzte
Variante ist eine Benchmark-Kontrolle, kein heimlich geänderter alter Suchmodus.
Zehn zusätzliche Dateinamen-Abfragen prüfen, dass exakte Suche erhalten bleibt.

Vollständige Messdaten liegen für diesen Lauf unter
`/Users/master/BASE/data/fe-instantfind-20261113/`. Sie belegen diesen kleinen Korpus,
keine universelle Trefferquote. Die warme Suchzeit und Modellstartzeit werden
getrennt angegeben. Der Gesamt-RAM-Wert ist die konservative Summe der jeweils
größten beobachteten Bun- und Python-Prozesswerte; diese Spitzen müssen nicht
gleichzeitig auftreten. Eine Pause von zehn Sekunden prüft nur kurze Inaktivität.


## Vergleich mit echten Projektdateien

Der zweite Test verwendet 42 unveränderte Dateien aus den vorhandenen Repositories
Find Everything und Superskills. 48 neue Fragen, je 24 deutsch/englisch, samt
Zieldateien und Quellen-Hashes wurden vor dem Test eingefroren. Keine künstlichen
Dokumenttexte, kein Training und keine Änderung der Suchparameter anhand dieser
Fragen. Vollständige Top-20-Listen waren zwischen altem und kompaktem Tokenizer
identisch: 35/48 auf Platz 1, 43/48 unter den ersten 3, 48/48 unter den ersten 20.
Die lexikalische FTS-OR-Kontrolle erreichte 13/48, 22/48 und 31/48.

Das Backend sank im gemessenen Lauf von 560,7 auf 177,6 MiB als Summe der
Prozessspitzen. Der kompakte Tokenizer hält nur begrenzte Caches und liest BPE-Regeln
aus SQLite, statt das vollständige Vokabular als große Laufzeitstruktur vorzuhalten.
Die Ergebnisse dieses begrenzten entwicklernahen Korpus sind kein Nachweis für
beliebige persönliche Dokumente. Messdaten und Leerlaufprüfung liegen unter
`/Users/master/BASE/data/fe-instantfind-real-20261113/`.
