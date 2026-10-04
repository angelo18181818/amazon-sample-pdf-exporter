# Amazon Sample PDF Exporter

A Tampermonkey userscript that adds a download button to Amazon pages with **Read Sample** and exports the loaded sample pages as a PDF.

Tested on:

- Google Chrome
- Mozilla Firefox

> Note: on Chrome, you must manually enable user scripts in the extension settings.

## Features

- Dedicated PDF button next to **Read Sample**
- Exports Amazon sample pages to PDF
- Inline progress percentage inside the button
- Automatic reader scrolling to load pages
- Automatic reader cleanup at the end of the process
- Clears previously loaded sample images from manual reader sessions

## Installation

1. Install Tampermonkey:
   - Chrome: https://www.tampermonkey.net/?browser=chrome
   - Firefox: https://www.tampermonkey.net/?browser=firefox
2. Open `amazon-sample-pdf-exporter-progress.user.js` on GitHub.
3. Click **Raw**.
4. Tampermonkey should automatically open the script installation page.
5. Click **Install**.

## Chrome Setup

Chrome may block user scripts until the proper permission is enabled.

Do this:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Find **Tampermonkey**
4. Click **Details**
5. Enable **Allow user scripts**
6. Reload the Amazon page

On the first export, Chrome or Tampermonkey may also ask for permission to download files. Allow downloads, otherwise the PDF may be generated but not saved correctly.

## Firefox Setup

On Firefox, installing Tampermonkey and then installing the script from GitHub's **Raw** button is usually enough.

If the download does not start:

1. Make sure Tampermonkey is enabled.
2. Make sure the script is enabled in the Tampermonkey dashboard.
3. Reload the Amazon page.

## Usage

1. Open an Amazon page that contains **Read Sample**.
2. Wait for the page to fully load.
3. Click the gold PDF button.
4. Let the script run until completion.
5. Save the PDF when the browser asks.

## Notes

- The script only works on samples available through Amazon Read Sample.
- It does not modify the book content: it collects the images already loaded by the sample reader.
- Use this script only for content you are allowed to view and in accordance with Amazon's terms and copyright law.

## Main File

`amazon-sample-pdf-exporter-progress.user.js`

Current version: `2.10.7`

## License

MIT
