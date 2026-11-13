# Instantfind für Dokumente und Projektdateien

`meaning:"…"` sucht nach der Bedeutung einer Beschreibung. Die vorhandene
Dateinamen-/Pfadsuche, wörtliche `content:`-Suche und CLAP-Audiosuche bleiben erhalten.
Der neue Weg ist optional und funktioniert im Suchfeld der App, über CLI und API.

## Lokale Vorbereitung

Es werden keine Bibliotheken oder Modellgewichte automatisch heruntergeladen.
Die erste Einrichtung benötigt einen lokalen ONNX-Gemma-Q4-Export und eine
Python-Umgebung mit `numpy`, `onnxruntime` und `tokenizers`.

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
- Nach zehn Minuten Inaktivität darf der bestehende Suchprozess enden. Dann fällt
  beim nächsten Bedeutungsaufruf erneut ein Modellstart an. Dieser Fall wurde nicht
  durch eine zehnminütige Messung als beseitigt nachgewiesen.
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
