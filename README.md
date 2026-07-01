# Amazon Sample PDF Exporter

Userscript per Tampermonkey che aggiunge un pulsante di download alle pagine Amazon con **Read Sample / Leggi estratto** e crea un PDF dalle immagini del sample.

Testato su:

- Google Chrome
- Mozilla Firefox

> Nota: su Chrome serve abilitare manualmente l'esecuzione degli userscript nelle impostazioni dell'estensione.

## Funzioni

- Pulsante dedicato vicino a **Read Sample**
- Esportazione del sample Amazon in PDF
- Avanzamento percentuale dentro il pulsante
- Scroll automatico del reader per caricare le pagine
- Chiusura automatica del reader al termine del processo
- Pulizia delle immagini gia caricate da aperture manuali precedenti del sample

## Installazione

1. Installa Tampermonkey:
   - Chrome: https://www.tampermonkey.net/?browser=chrome
   - Firefox: https://www.tampermonkey.net/?browser=firefox
2. Apri il file `amazon-sample-pdf-exporter-progress.user.js` su GitHub.
3. Clicca **Raw**.
4. Tampermonkey dovrebbe aprire automaticamente la schermata di installazione.
5. Clicca **Install**.

## Configurazione su Chrome

Chrome puo bloccare gli userscript finche non abiliti il permesso corretto.

Fai cosi:

1. Apri `chrome://extensions`
2. Attiva **Modalita sviluppatore**
3. Trova **Tampermonkey**
4. Clicca **Dettagli**
5. Attiva **Permetti scripts utente** / **Allow user scripts**
6. Ricarica la pagina Amazon

Alla prima esportazione Chrome o Tampermonkey potrebbe chiedere anche il permesso per scaricare file. Accetta il permesso di download, altrimenti il PDF potrebbe essere generato ma non salvato correttamente.

## Configurazione su Firefox

Su Firefox di solito basta installare Tampermonkey e poi installare lo script dal pulsante **Raw** di GitHub.

Se il download non parte:

1. Controlla che Tampermonkey sia attivo.
2. Controlla che lo script sia abilitato nella dashboard di Tampermonkey.
3. Ricarica la pagina Amazon.

## Uso

1. Apri una pagina Amazon che contiene **Read Sample** o **Leggi estratto**.
2. Aspetta che la pagina sia caricata.
3. Clicca il pulsante dorato del PDF.
4. Lascia lavorare lo script fino al completamento.
5. Salva il PDF quando il browser lo richiede.

## Note

- Lo script funziona solo sui sample accessibili tramite Amazon Read Sample.
- Non modifica il contenuto del libro: raccoglie le immagini gia caricate dal reader del sample.
- Usa lo script solo per contenuti che hai il diritto di visualizzare e nel rispetto dei termini di Amazon e del copyright.

## File principale

`amazon-sample-pdf-exporter-progress.user.js`

Versione attuale: `2.8.3`

## Licenza

MIT
