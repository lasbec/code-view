# Darstellungen für Abhängigkeiten und Änderungsauswirkungen

Recherche: 13. November 2026. Untersucht wurden offizielle Produktdokumentationen und das aktuelle Code-View-Datenmodell. Die folgenden Gestaltungsempfehlungen sind eigene Ableitungen; die Quellen belegen die zugrunde liegenden Praxisbeispiele.

## Ergebnis

Datei- und Funktionsansicht können dieselben Darstellungen und Bedienelemente verwenden. Sie sollten jedoch unterschiedliche, ausdrücklich bezeichnete Beziehungen darstellen. Empfohlen sind eine aufklappbare Hierarchie als Standard und ein fokussierter gerichteter Graph als Ergänzung. Eine Abhängigkeitsmatrix eignet sich als spätere Architekturansicht. Eine sortierbare Ergebnisliste unterstützt die Untersuchung größerer Mengen potenziell betroffener Elemente.

## 1. Aufklappbare Hierarchie

**Praxisbeleg:** ReSharper bietet eingehende und ausgehende Aufrufhierarchien, das schrittweise Erweitern von Knoten und das Ausblenden einzelner Zweige. [Call Hierarchy](https://www.jetbrains.com/help/resharper-vscode/Code_Analysis__Call_Tracking.html). Die VS-Code-API modelliert eingehende und ausgehende Aufrufe einschließlich ihrer Quellstellen. [VS Code API](https://code.visualstudio.com/api/references/vscode-api#CallHierarchyIncomingCall).

**Empfehlung für Code View:** Zwei Richtungen „Verwendet von“ und „Verwendet“. Jeder Zweig wird erst beim Aufklappen erweitert. Ein Eintrag zeigt Name, Datei, Anzahl statischer Fundstellen und einen Link zur Quelle. Wiederkehrende Knoten erhalten einen Rückverweis; rekursive Zweige werden nicht endlos erweitert. Ein Element darf in mehreren Zweigen vorkommen, weil unterschiedliche Pfade eine unterschiedliche Erklärung liefern.

- Datei: importierende/importierte Dateien; alternativ tatsächliche dateiübergreifende Symbolverwendungen.
- Funktion: aufrufende/aufgerufene Funktionen. Sonstige Referenzen wie Übergabe als Callback getrennt anbieten, weil eine Referenz keinen direkten Aufruf beweist.

Die Hierarchie eignet sich besonders für die Frage „Über welche Kette kommt diese Abhängigkeit zustande?“ und passt in die vorhandenen Detailansichten.

## 2. Fokussierter gerichteter Graph

**Praxisbeleg:** NDepend unterstützt Graphen für verwendende und verwendete Klassen mit direkter, begrenzter oder maximaler Tiefe. Kanten können auf die beteiligten Methoden und Felder aufgeklappt werden. [Class Dependency Diagram](https://www.ndepend.com/docs/class-dependency-diagram/).

**Empfehlung für Code View:** Das ausgewählte Element bildet den Fokus. Anfangs nur direkte Nachbarn zeigen, anschließend gezielt erweitern. Pfeile bedeuten durchgehend „A verwendet B“; die Anzeige der Änderungsauswirkungen verfolgt diese Pfeile rückwärts. Ein festes, gerichtetes Layout hält den Fokus stabil. Steuerung: Richtung, Tiefe, Beziehungstyp, interne/externe Ziele und Zurücksetzen. Bei großen Nachbarschaften eine sichtbare Begrenzung mit „weitere anzeigen“ anbieten.

Kanten öffnen ihre Belege: Import oder konkrete Aufruf-/Referenzstellen. Zyklen werden umrandet und zusätzlich als lesbarer Pfad angeboten. Farbe allein reicht dafür nicht. Externe und nicht eindeutig aufgelöste Ziele bleiben unterscheidbar; aus unbekannten Zielen darf keine präzise Fortsetzung erfunden werden.

Datei und Funktion können denselben Graph-Renderer verwenden. Ein Klick auf eine Dateikante sollte die beteiligten Funktionsaufrufe oder Symbolverwendungen zeigen. Dabei bleiben reine Importbeziehungen ohne konkrete Funktionsverbindung möglich.

## 3. Abhängigkeitsmatrix für Architektur und Zyklen

**Praxisbeleg:** JetBrains zeigt Abhängigkeiten in einer interaktiven DSM mit Projektstruktur, Abhängigkeitsstärke, gegenseitigen Beziehungen und Navigation zu den verursachenden Verwendungen. [Dependency Structure Matrix](https://www.jetbrains.com/help/idea/dsm-analysis.html). NDepend beschreibt Matrix und Graph als alternative Darstellungen desselben Beziehungsmodells und hebt Zyklen als zusammenhängende Blöcke hervor. [Dependency Structure Matrix](https://www.ndepend.com/docs/dependency-structure-matrix-dsm).

**Empfehlung für Code View:** Zeilen und Spalten enthalten dieselben Elemente; die Zelle bedeutet ausdrücklich „Zeile verwendet Spalte“. Eine Zelle zeigt zunächst die Zahl statischer Fundstellen, beim Öffnen deren Belege. Gruppierung nach Ordnern und Dateien, Suche und Begrenzung auf eine Auswahl halten den Ausschnitt beherrschbar. Stark zusammenhängende Komponenten werden als Zyklusgruppen markiert; eine bloße Prüfung auf paarweise gegenseitige Kanten übersieht längere Zyklen.

Die Matrix hat ihren größten Nutzen auf Datei-/Ordnerebene. Für Funktionen ist sie als begrenzter Ausschnitt sinnvoll, etwa für alle Funktionen einer Datei oder einer ausgewählten Zyklusgruppe. Eine projektweite Funktionsmatrix sollte daher kein erster Einstieg sein.

## 4. Liste potenziell betroffener Elemente

**Praxisbeleg:** NDepend zeigt die indirekte Nutzungstiefe und bietet Untersuchungsergebnisse sowohl als Liste als auch als Graph an. [Refactoring Impact Analysis](https://www.ndepend.com/docs/refactoring-impact-analysis/).

**Empfehlung:** Ergänzend zu Baum und Graph eine Tabelle mit Element, direkter/indirekter Abhängigkeit, minimaler Entfernung und einem aufklappbaren Erklärungspfad. Eindeutige Elemente zählen, auch wenn mehrere Wege zu ihnen führen. Dies unterstützt die praktische Frage „Welche Stellen sollte ich bei dieser Änderung prüfen?“ Die Liste behauptet keine sicheren Laufzeitfolgen.

## Gemeinsame Oberfläche und unterschiedliche Bedeutung

| Aspekt | Dateien | Funktionen |
| --- | --- | --- |
| Knoten | Datei, optional Ordnergruppe | Funktion, optional Dateigruppe |
| Primäre Beziehungen | Import/Reexport; getrennt tatsächliche Symbolverwendung | aufgelöster Aufruf |
| Zusätzliche Beziehungen | dynamischer Import, externe Ziele | Konstruktoraufruf, sonstige Funktionsreferenz |
| Zyklus bedeutet | zyklische Dateibeziehung | rekursiver Aufrufzusammenhang |
| Quellenbeleg | Import-/Verwendungsstelle | Aufruf-/Referenzstelle |

Renderer, Navigation, Suchfunktion, Tiefensteuerung und Darstellung von Belegen können geteilt werden. Die Beziehungsauswahl muss vor der Traversierung gelten; nachträgliches Ausblenden von Kanten kann unerklärbare indirekte Ergebnisse erzeugen. Datei- und Funktionspfade sind nicht austauschbar: Aus `A.f → B.g` und `B.h → C.i` folgt ein Dateipfad `A → B → C`, aber keine Aufrufkette von `A.f` nach `C.i`. Ebenso beweist ein Dateizyklus keine Funktionsrekursion.

## Vorhandene Daten und notwendige Ergänzungen

Lokal geprüft: [Ergebnisschema](../../src/code-inspector/code-inspection-result-schema.md), [Inspector](../../src/code-inspector/typescript/src/analyze.mjs), [Datenbankschema](../../src/code-inspector/typescript/src/database.mjs), [Server-Dokumentation](../../src/server/README.md).

- `code_calls` bietet Quelle, Ziel, Aufrufart, Auflösungsstatus und Position. `caller_id = NULL` beschreibt Modulcode und braucht einen eigenen Modulkontext statt einer erfundenen Funktion.
- `code_function_references` enthält mehr als Aufrufe. Ein gemeinsamer Graph muss diese Kanten getrennt behandeln und direkte Aufrufe nicht doppelt zählen.
- `code_imports` enthält `import`, `reexport`, `dynamic`, jedoch keine Kennzeichnung für reine Typimporte. Ein belastbarer Filter „Typ/Laufzeit“ benötigt eine Inspector-Erweiterung und neue Inspektion.
- `code_symbol_references` enthält dateiübergreifende Laufzeitsymbolverwendungen; vollständige Typabhängigkeiten sind damit nicht verfügbar.
- Externe oder durch Filter ausgeschlossene Ziele sowie dynamische Aufrufe begrenzen die Vollständigkeit. Aktuelle Quellvorschauen können von gespeicherten Analysepositionen abweichen.

Priorität als eigene Empfehlung: zuerst Hierarchie und Erklärungsliste mit sauberem Beziehungsmodell; anschließend fokussierter Graph und Zyklusgruppen; DSM danach als Architekturwerkzeug. Hierfür wurden keine Programmänderungen vorgenommen.
