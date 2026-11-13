# TypeScript Code Inspector

Statische Analyse eines TypeScript-Projekts mit SQLite-Ausgabe. Benötigt Node.js ab 22.13 (mit `node:sqlite`). Es wird kein untersuchter Code ausgeführt. Die TypeScript Compiler API ist auf Version 5.9.3 festgelegt.

```bash
cd src/code-inspector/typescript
npm ci
npm run inspect -- --tsconfig /pfad/repo/tsconfig.json --output /pfad/analyse.sqlite
npm run inspect -- -p /pfad/repo/tsconfig.json -o /pfad/analyse.sqlite \
  --include 'src/**/*.ts' --include 'src/**/*.tsx' --exclude '**/*.test.ts'
npm test
```

`--tsconfig` und `--output` sind erforderlich. Globs sind relativ zum Verzeichnis der Haupt-tsconfig, nicht zum Arbeitsverzeichnis. Includes schränken die tsconfig-Dateimenge ein; Excludes ziehen Dateien davon ab. Globs in der Shell quoten. Tests werden standardmäßig analysiert, sofern die tsconfig sie enthält. Deklarationsdateien und `node_modules` werden nicht als Ergebnisdateien erfasst. Build-Dateien sollten in der tsconfig ausgeschlossen sein. Projektverweise werden rekursiv mit ihren jeweiligen Compileroptionen geladen. JavaScript wird bei `allowJs` berücksichtigt.

## SQLite-Ausgabe

Jeder Lauf analysiert alle aktuell ausgewählten Dateien und baut die bekannten Skripttabellen, Views und explizit benannten Indizes mit dem Präfix `code_` vollständig neu auf. Die SQLite-Datei bleibt bestehen. Fremde Objekte, unbekannte `code_`-Tabellen und alte Tabellen ohne Präfix bleiben erhalten. Bestehende Datenbanken dürfen auch Ergebnisse einer anderen Haupt-tsconfig enthalten; deren bekannte `code_`-Objekte werden ersetzt.

CLI-Filter bestimmen den gesamten neuen Ergebnisbestand. Ein Lauf mit `--include 'src/a.ts'` enthält anschließend ausschließlich die Ergebnisse dieser Auswahl. Ergebnisse zuvor ausgewählter Dateien werden nicht übernommen. Ohne Filter wird die gesamte aktuelle tsconfig-Dateimenge analysiert. Quellpositionen sind Teil der IDs; Änderungen können IDs verschieben.

Löschen, Schemaaufbau und Speicherung erfolgen in einer gemeinsamen SQLite-Transaktion. Erst ein erfolgreicher Lauf übernimmt die neuen Ergebnisse. Bei einem Fehler oder Abbruch bleiben die bisherigen Ergebnisse erhalten. Während des Neuaufbaus ist die Datenbank für andere Schreiber gesperrt. Fremdschlüssel werden vor dem Commit für die gesamte Datenbank geprüft; verletzte Referenzen verhindern die Übernahme. Löschkaskaden in fremden Tabellen werden beim Schemawechsel unterbunden.

Syntax- oder Konfigurationsfehler brechen vor dem Schreiben ab. Semantische TypeScript-Diagnosen werden gespeichert: fehlende Abhängigkeiten können die Symbolauflösung verschlechtern. Es handelt sich nicht um einen Watch-Prozess. Spaltenbeschreibungen werden nicht gespeichert.

## Datenmodell

- `code_files`: Pfad, Zeilenmetriken, Importanweisungen, importierte Bindungen, dynamische Imports, Re-Exports und exportierte Modulvariablen.
- `code_functions`: Funktionsdeklarationen, Function Expressions, Arrow Functions, Methoden, Konstruktoren, Getter und Setter mit Implementierung; Name, Art, Position, Elternfunktion, Metriken und Terminierung. Overload-Signaturen zählen nicht zusätzlich.
- `code_parameters`: Reihenfolge, Name bzw. Binding-Pattern, Typ, optional/rest und definite/mögliche Mutationen.
- `code_accesses`: einzelne Zugriffe mit Symbolherkunft, Position, Ausdruck, Scope, Lese-/Schreib-/Mutationsflags und Effektgewissheit.
- `code_calls`: einzelne statische Aufrufstellen, einschließlich Konstruktoraufrufen, mit Caller und auflösbarem Ziel. Aufrufe auf Modulebene haben keinen Caller.
- `code_function_references`: Funktionsverwendungen nach `direct_call`, `argument`, `assignment`, `return`, `export`, `other`. Direkte Aufrufe sind zusätzlich als Referenz mit diesem expliziten Typ sichtbar; für Verwendungen ohne Aufruf nach `kind <> 'direct_call'` filtern. Importdeklarationen allein zählen nicht als Verwendung.
- `code_shadowing`: ein Ereignis pro verdeckender Deklaration, einschließlich Parameter, mit verdecktem Symbol. Reine Typnamen zählen nicht.
- `code_diagnostics`, `code_metadata`, `code_file_state`: Compilerdiagnosen, Analysekonfiguration und neu berechnete Datei-Fingerprints.

Views: `code_call_counts`, `code_access_counts`, `code_file_function_counts`. Positionen sind 1-basiert, Pfade relativ zur Haupt-tsconfig. Ziel-IDs von Aufrufen und Referenzen sind bewusst keine Fremdschlüssel: Dateifilter können Ziele außerhalb des gespeicherten Bestands ergeben. `NULL` bedeutet, dass kein eindeutiges analysiertes Ziel aufgelöst wurde. `resolution` unterscheidet `resolved`, `ambiguous` und `unknown`.

```sql
-- A ruft B an wie vielen Quellstellen auf?
SELECT a.name AS caller, b.name AS callee, SUM(c.call_count) AS sites
FROM code_call_counts c
JOIN code_functions a ON a.id = c.caller_id
JOIN code_functions b ON b.id = c.target_id
GROUP BY a.id, b.id;

-- Externe Zustandszugriffe nach Scope und Gewissheit
SELECT f.name, a.scope, a.effect, a.reads, a.writes, a.mutations
FROM code_access_counts a JOIN code_functions f ON f.id = a.function_id;

-- Funktionen, die als Argument weitergegeben werden
SELECT f.name, r.file_id, r.line, r.column
FROM code_function_references r JOIN code_functions f ON f.id = r.target_id
WHERE r.kind = 'argument';
```

## Zählregeln

**Zeilen:** `total_lines` ist die originale Zeilenspanne, `comment_lines` zählt reine Kommentarzeilen, `blank_lines` Leerzeilen, `effective_lines` Zeilen mit Code. Es gilt `total = comment + blank + effective`. `lines_with_comments` enthält zusätzlich gemischte Code-/Kommentarzeilen. Der abschließende Zeilenumbruch erzeugt keine zusätzliche Leerzeile. Literale werden anhand des TypeScript-AST erkannt. Die originale Länge einer Funktion umfasst enthaltene Funktionsdefinitionen; deren Kontrollfluss, Zugriffe, Aufrufe und Shadowing werden jeweils nur der inneren Funktion zugerechnet.

**Schachtelung:** Maximum gleichzeitig umgebender `if`, Schleifen, `switch`, `catch` und ternärer Ausdrücke. Einfache Blöcke erhöhen die Tiefe nicht. Ein `else if` wird als verschachteltes `if` gezählt.

**Komplexität:** Zyklomatisch: Basis 1, je 1 für `if`, Schleife, `catch`, ternären Ausdruck, nicht-default `case`, `&&`, `||`, `??`. Kognitiv: pro Kontrollstruktur `1 + aktuelle Tiefe`, zusätzlich 1 pro logischem Operator, einfachem `else` und beschriftetem `break`/`continue`. Dies ist eine explizite lokale Metrik, keine vollständige Sonar-Kompatibilität.

**Externe Zugriffe:** Scopes sind `outer_function`, `module`, `global`, `class_field`. `parameter` ergänzt diese für von außen sichtbare Mutationen an Parameterobjekten. Lokale Variablen und das reine Neuzuweisen eines Parameters zählen nicht. `x++` zählt als Lesen und Schreiben, `obj.x++` als Lesen und Mutation. Ein Zugriff auf `obj.a.b` zählt einmal mit dem Wurzelsymbol, keine drei separaten Zugriffe. Bei Klassenfeldern wird das deklarierte Feld bevorzugt kategorisiert. Mutation lokaler, neu erzeugter Objekte wird nicht als externer Zugriff gezählt.

Direkte Objektänderungen und einfache `const`-Aliase werden verfolgt. Unbedingte lokale Neuzuweisung kann den Bezug zum ursprünglichen Parameter entfernen; zuvor erzeugte Aliase behalten ihre Herkunft. Bedingte Neuzuweisungen machen folgende Effekte möglich statt definitiv. Bekannte mutierende Methoden von Arrays, Maps und Sets werden erkannt. Unbekannte Methoden und die Übergabe von Objekten an andere Funktionen ergeben mögliche Mutationen; diese sind separat von definitiven Mutationen gespeichert. Das ist eine begrenzte syntaktische Aliasverfolgung, keine vollständige pfadsensitive Heap-Analyse. Insbesondere komplexe Destrukturierungen, dynamische Eigenschaften, Objekt-Escapes und Effekte durch mehrere Funktionen hindurch werden nicht vollständig modelliert.

**Terminierung:** `terminates` oder `unknown`. Alle Schleifen (auch offensichtlich endliche), `await`, `yield`, Property-/Elementzugriffe, `throw`, `new`, Tagged Templates und ungeklärte Aufrufe führen konservativ zu `unknown`. Bekannte direkte Aufrufe werden durch einen Fixpunkt über den Aufrufgraphen berücksichtigt. Rekursive Zyklen bleiben unbekannt. `terminates` gilt innerhalb dieses strukturellen Modells, nicht als formaler Beweis über beliebige JavaScript-Laufzeitwerte: implizite Typkonvertierungen, Proxies, manipulierte Laufzeitbindungen und native Laufzeitdetails werden nicht bewiesen. Compiler- oder Laufzeitcode wird nie ausgeführt.

**Auflösung:** Die TypeScript-Symbole liefern direkte statische Ziele inklusive Imports und einfacher konstanter Funktionsaliase. Aufrufe über Funktionsparameter, nicht auflösbare Interface-Implementierungen oder dynamische Zugriffe bleiben unbekannt. Ein statisches Methodenziel ist keine Garantie, welche Implementierung bei dynamischem Dispatch tatsächlich läuft. Häufigkeiten sind Quellstellen, keine Laufzeitfrequenzen.

Compiler API: https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
