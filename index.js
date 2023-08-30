const puppeteer = require('puppeteer');

async function scrapeMLBStats() {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: false });
        const page = await browser.newPage();

        await page.goto('https://www.espn.com/mlb/players');

        // Extract team roster URLs based on the provided HTML structure
        const rosterUrls = await page.$$eval('.mod-content ul li div[style="float:left;"] a', links => links.map(link => link.href));

        for (let rosterUrl of rosterUrls) {
            await page.goto(rosterUrl);

            // Assuming each player's stats page is linked from the roster page, extract those links
            // This selector might need to be updated based on the actual structure of the roster page
            const playerLinks = await page.$$eval('a.AnchorLink[href*="/mlb/player/_/id/"]', links => links.map(link => link.href));

            for (let link of playerLinks) {
                await page.goto(link);

                const playerName = await page.$eval('.PlayerHeader__Name', el => el.textContent);
                const hits = await page.$$eval('.Table__TR .Table__TD:nth-child(7)', cells => cells.map(cell => parseInt(cell.textContent)));
                console.log(hits)
                let zeroHitsStreak = 0;
                for (let i = 0; i < hits.length; i++) {
                    if (hits[i] === 0) {
                        zeroHitsStreak++;
                        if (zeroHitsStreak === 2 || zeroHitsStreak === 3) {
                            console.log(`${playerName}: ${hits.join(', ')}`);
                            break;
                        }
                    } else {
                        zeroHitsStreak = 0;
                    }
                }
            }
        }

    } catch (error) {
        console.error('An error occurred:', error.message);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

scrapeMLBStats();
