# Created-, Deleted- und Changed-Zeilen

Recherche: 13. November 2026. Primärquellen: JetBrains- und Microsoft-Quellcode sowie offizielle Git-Dokumentation. Dies ist eine Recherche und Implementierungsempfehlung; der Git-Inspector wurde dafür nicht verändert.

## Was IntelliJ tatsächlich macht

IntelliJ zeigt neue, gelöschte, geänderte und ausschließlich in Whitespace geänderte Zeilen unterschiedlich an. Die Dokumentation beschreibt diese Anzeige, definiert aber keine drei disjunkten numerischen Zähler für Commit-Statistiken. [JetBrains: Add files to Git and track changes](https://www.jetbrains.com/help/idea/adding-files-to-version-control.html)

Im Quellcode enthält ein `Range` einen alten und einen neuen Zeilenbereich. Ist die neue Seite leer, ist der Bereich gelöscht; ist die alte Seite leer, eingefügt; sind beide nicht leer, geändert. Daraus folgt keine semantische Paarung einzelner Zeilen. [JetBrains: Range.kt](https://github.com/JetBrains/intellij-community/blob/master/platform/diff-impl/src/com/intellij/openapi/vcs/ex/Range.kt)

`RangesBuilder` richtet zuerst mit ignoriertem Whitespace aus und markiert danach nur exakt gleiche Zeilen als unverändert. Optionale innere Bereiche unterscheiden reine Whitespace-Änderungen. Auch dort entsteht die Klassifikation aus der Belegung beider Seiten eines Bereichs. Das ist mehr als ein Vergleich der dateiweiten Additions- und Löschungssummen. [JetBrains: RangesBuilder.kt](https://github.com/JetBrains/intellij-community/blob/master/platform/diff-impl/src/com/intellij/openapi/vcs/ex/RangesBuilder.kt)

Der zugrunde liegende `ByLineRt`-Vergleich richtet zuerst aussagekräftigere Zeilen aus, korrigiert Lücken und optimiert Blockgrenzen. Er berücksichtigt Whitespace in mehreren Schritten. Ein bloßer Ähnlichkeitsschwellwert für beliebige alte/neue Zeilen beschreibt diesen Algorithmus nicht. [JetBrains: ByLineRt.kt](https://github.com/JetBrains/intellij-community/blob/master/platform/util/diff/src/com/intellij/diff/comparison/ByLineRt.kt)

**Wichtig:** Die Formel `changed = min(added, deleted)` wurde in diesen Quellen nicht als IntelliJ-Statistik gefunden. Bei ungleichen Bereichslängen klassifiziert IntelliJ einen ganzen Bereich als geändert. Eine daraus abgeleitete disjunkte Statistik braucht eine eigene, ausdrücklich dokumentierte Zählkonvention.

## Vergleich mit VS Code und Git

VS Code kombiniert einen Zeilenvergleich mit anschließender Zeichenverfeinerung. Für kürzere Sequenzen verwendet es dynamische Programmierung, für längere Myers. Whitespace und die separate Erkennung verschobener Bereiche sind Optionen. Damit sind Diffbereiche ein passendes Vorbild; identische Ergebnisse verschiedener Editoren sind nicht garantiert. [Microsoft: DefaultLinesDiffComputer](https://github.com/microsoft/vscode/blob/main/src/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.ts)

Git bietet Myers sowie andere Diffalgorithmen. `--numstat` liefert nur hinzugefügte/gelöschte Zeilen, bei Binärdateien unbekannte Werte. `--unified=0` entfernt Kontext; `--inter-hunk-context=0` verhindert das konfigurationsbedingte Zusammenfassen benachbarter Hunks. Whitespace-Ignorieren und Verschiebungsdarstellung sind explizite Optionen. [Git: diff options](https://git-scm.com/docs/diff-options)

## Empfehlung für diesen Inspector

**Eigene Ableitung aus den recherchierten Werkzeugen:** Git-Myers als verfügbaren, etablierten Zeilendiff verwenden; die daraus entstehenden lokalen Ersetzungsbereiche wie IDE-Diffbereiche behandeln. Keine neue semantische Ähnlichkeitsheuristik und kein Port der gesamten IntelliJ-Engine einführen. Das Verfahren als blockbasierte Zählung dokumentieren, nicht als zahlenidentische IntelliJ-Implementierung.

Für jeden zusammenhängenden Änderungsblock mit `A` hinzugefügten und `D` entfernten Zeilen zählen:

```text
changed = min(A, D)
created = A - changed
deleted = D - changed
```

Unveränderte Zeilen, Datei- und Hunkgrenzen beenden einen Block. Eine Löschung am Dateianfang und eine Einfügung am Ende werden deshalb nicht miteinander gepaart. Beispiel innerhalb desselben Blocks: `A=10, D=4` ergibt `created=6, deleted=0, changed=4`. Das ist die gewählte Zählkonvention oberhalb des Diffalgorithmus, keine bestätigte IntelliJ-Zählerformel.

Für reproduzierbare Ergebnisse Diffalgorithmus, Kontext und Farbausgabe explizit setzen; auch Indent-Heuristik und Whitespaceregel dürfen nicht unbemerkt von lokaler Git-Konfiguration abhängen. Bestehende Rename-, Root- und First-Parent-Regeln beibehalten. Eine konsistente Wahl für Patch und bisherige Statistik verhindert divergierende Summen.

Standardmäßig Whitespace mitzählen, einschließlich Einrückung und Zeilenenden. Keine `-w`-, `-b`- oder CR-Ignorieroption hinzufügen. Verschobene Zeilen bleiben Löschung plus Einfügung, wenn sie in getrennten Blöcken liegen. Kommentare und Leerzeilen bleiben Textzeilen; es handelt sich nicht um sprachspezifische Codezeilen.

## Speicherung und Gewichtung

Lokal geprüft: [Git-Inspector](../../src/git-inspector/git_inspector.py), insbesondere `update_churn`, speichert bisher nur `lines_added`, `lines_deleted`, `churn` und `is_binary`. Neue `created`-, `deleted`- und `changed`-Zähler müssen während der Inspection aus Patchdaten berechnet werden. Alte Summen enthalten keine Blockgrenzen; eine präzise Nachbefüllung benötigt erneuten Zugriff auf Git-Diffs.

Bisherige Git-Werte und neue Zähler getrennt erhalten:

```text
lines_added   = created + changed
lines_deleted = deleted + changed
legacy_churn  = created + deleted + 2 * changed
contribution  = w_created * created + w_deleted * deleted + w_changed * changed
```

Die Gleichungen gelten, wenn Patch und bisherige Summen dieselben Diffregeln verwenden. Nutzerentscheidung: neue Gewichte standardmäßig **1/1/1**, einzeln einstellbar in der rechten Sidebar. Der so gewichtete Beitrag ist von bisherigem Git-Churn zu unterscheiden. Binärdateien behalten unbekannte Zeilenzahlen statt erfundener Nullen; reine Textdatei-Neuanlagen zählen ausschließlich als created, vollständige Löschungen als deleted. Für alte Ergebnisse bis zur erneuten Inspection fehlende Kategorien als nicht verfügbar anzeigen.
