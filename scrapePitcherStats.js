const puppeteer = require('puppeteer');
const fs = require('fs');
let pitcherStats = [];
const parallelPlayers = 5;
const parallelBrowsers = 1;

const browserPool = [];
const pagePool = [];

const teamsMap = JSON.parse(fs.readFileSync('teams.json', 'utf8'));

async function initialize() {
    for (let i = 0; i < parallelBrowsers; i++) {
        const browser = await puppeteer.launch({
            headless: false,
            defaultViewport: { width: 1400, height: 1000 },
        });
        browserPool.push(browser);
        for (let j = 0; j < parallelPlayers; j++) {
            const page = await browser.newPage();
            await page.setDefaultNavigationTimeout(0);
            pagePool.push(page);
        }
    }
}

async function getBrowser() {
    return browserPool.shift();
}

async function getPage(browser) {
    return new Promise(async (resolve) => {
        const checkPagePool = async () => {
            if (pagePool.length > 0) {
                resolve(pagePool.shift());
            } else {
                setTimeout(checkPagePool, 200);
            }
        };
        await checkPagePool();
    });
}

function releasePage(page) {
    pagePool.push(page);
}

function releaseBrowser(browser) {
    browserPool.push(browser);
}

async function waitForPageLoad(page) {
    try {
        // Wait for network to be idle
        await page.waitForNetworkIdle({ timeout: 5000 });
        // Wait for the main content to be loaded
        await page.waitForSelector('body', { timeout: 5000 });
    } catch (error) {
        console.log('Page load timeout, continuing anyway...');
    }
}

async function navigateWithRetry(page, url, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await page.goto(url);
            await waitForPageLoad(page);
            return true;
        } catch (error) {
            console.log(`Navigation attempt ${i + 1} failed for ${url}: ${error.message}`);
            if (i === maxRetries - 1) {
                console.error(`Failed to navigate to ${url} after ${maxRetries} attempts`);
                return false;
            }
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return false;
}

async function getPitcherStats(page, game, browser) {
    try {
        // Use canonical team names from the game object
        const gameId = game.matchLink.split('/gameId/')[1].split('/')[0];
        const homeTeam = game.homeTeam.name;
        const awayTeam = game.awayTeam.name;
        const gameUrl = game.matchLink;

        const navigationSuccess = await navigateWithRetry(page, gameUrl);
        if (!navigationSuccess) {
            return null;
        }
        
        // Check if probable pitchers section exists with a timeout
        const hasProbablePitchers = await Promise.race([
            page.evaluate(() => {
                return !!document.querySelector('.Pitchers__Module');
            }),
            new Promise(resolve => setTimeout(() => resolve(false), 5000))
        ]);

        if (!hasProbablePitchers) {
            console.log(`No probable pitchers found for game: ${gameUrl}`);
            return null;
        }

        // Get the pitcher information from the game page
        const pitcherInfo = await page.$eval('.Pitchers__Module', section => {
            const pitcherElements = section.querySelectorAll('.Pitchers__Athlete');
            const pitchers = [];
            
            pitcherElements.forEach((pitcherEl, index) => {
                const nameEl = pitcherEl.querySelector('.Athlete__PlayerName');
                const linkEl = pitcherEl.querySelector('a.Athlete__Link');
                
                if (nameEl && linkEl) {
                    const playerId = linkEl.href.split('/id/')[1].split('/')[0];
                    const playerName = nameEl.textContent.trim().toLowerCase().replace(/\s+/g, '-');
                    pitchers.push({
                        name: nameEl.textContent.trim(),
                        url: linkEl.href,
                        batVsPitchUrl: `https://www.espn.com/mlb/player/batvspitch/_/id/${playerId}`,
                        isHomeTeam: index === 1 // First pitcher is away team, second is home team
                    });
                }
            });
            
            return pitchers;
        });

        // For each pitcher, get their stats and all player stats against them
        const pitcherStats = [];
        for (const pitcher of pitcherInfo) {
            try {
                // Navigate directly to the bat vs pitch page
                const batVsPitchSuccess = await navigateWithRetry(page, pitcher.batVsPitchUrl);
                if (!batVsPitchSuccess) {
                    console.log(`Failed to load bat vs pitch page for ${pitcher.name}, skipping...`);
                    continue;
                }
                
                // Wait for the table to load with a shorter timeout
                try {
                    await page.waitForSelector('.bat-pitch', { visible: true, timeout: 5000 });
                    await page.waitForSelector('.ResponsiveTable.pt4.bat-pitch .Table.Table--align-right', { visible: true, timeout: 5000 });
                    
                    // Get pitcher's season stats from the header
                    const seasonStats = await page.$eval('.PlayerHeader__StatBlock', block => {
                        const stats = {};
                        const statItems = block.querySelectorAll('.StatBlockInner');
                        
                        statItems.forEach(item => {
                            const label = item.querySelector('.StatBlockInner__Label').textContent.trim();
                            const value = item.querySelector('.StatBlockInner__Value').textContent.trim();
                            const rank = item.querySelector('.StatBlockInner__Position')?.textContent.trim();
                            
                            switch(label) {
                                case 'W-L':
                                    stats.record = value;
                                    stats.recordRank = rank;
                                    break;
                                case 'ERA':
                                    stats.era = parseFloat(value);
                                    break;
                                case 'K':
                                    stats.strikeouts = parseInt(value);
                                    stats.strikeoutsRank = rank;
                                    break;
                                case 'WHIP':
                                    stats.whip = parseFloat(value);
                                    break;
                            }
                        });
                        
                        return stats;
                    });
                    
                    // Get all player stats against this pitcher
                    const playerStats = await page.evaluate(() => {
                        const table = document.querySelector('.ResponsiveTable.pt4.bat-pitch .Table.Table--align-right');
                        if (!table) return null;
                        
                        const players = [];
                        const rows = table.querySelectorAll('.Table__TBODY .Table__TR:not(:last-child)');
                        
                        rows.forEach(row => {
                            const cells = row.querySelectorAll('.Table__TD');
                            const playerCell = cells[0];
                            
                            if (playerCell) {
                                const playerName = playerCell.textContent.trim();
                                const playerUrl = playerCell.querySelector('a.AnchorLink')?.href;
                                
                                players.push({
                                    name: playerName,
                                    url: playerUrl,
                                    stats: {
                                        atBats: parseInt(cells[1].textContent) || 0,
                                        hits: parseInt(cells[2].textContent) || 0,
                                        doubles: parseInt(cells[3].textContent) || 0,
                                        triples: parseInt(cells[4].textContent) || 0,
                                        homeRuns: parseInt(cells[5].textContent) || 0,
                                        rbi: parseInt(cells[6].textContent) || 0,
                                        walks: parseInt(cells[7].textContent) || 0,
                                        strikeouts: parseInt(cells[8].textContent) || 0,
                                        battingAverage: parseFloat(cells[9].textContent) || 0,
                                        onBasePercentage: parseFloat(cells[10].textContent) || 0,
                                        sluggingPercentage: parseFloat(cells[11].textContent) || 0,
                                        ops: parseFloat(cells[12].textContent) || 0
                                    }
                                });
                            }
                        });
                        
                        return players;
                    });

                    if (playerStats) {
                        pitcherStats.push({
                            gameId: gameId,
                            pitcherName: pitcher.name,
                            pitcherUrl: pitcher.url,
                            pitcherTeam: pitcher.isHomeTeam ? homeTeam : awayTeam,
                            opponentTeam: pitcher.isHomeTeam ? awayTeam : homeTeam,
                            pitcherSeasonStats: seasonStats,
                            playerStats: playerStats
                        });
                    }
                } catch (error) {
                    console.log(`No bat vs pitch table found for pitcher ${pitcher.name}, skipping...`);
                    continue;
                }
            } catch (error) {
                console.error(`Error processing pitcher ${pitcher.name}:`, error.message);
                continue;
            }
        }

        return pitcherStats;
    } catch (error) {
        console.error(`Error getting pitcher stats for game ${gameUrl}:`, error.message);
        return null;
    }
}

async function processGames() {
    try {
        await initialize();
        
        // Read the matchups data
        const matchUps = JSON.parse(fs.readFileSync('matchUps.json', 'utf8'));

        // Create all promises upfront for true parallel processing
        const promises = [];
        const browsers = [];

        // Initialize all browsers first
        for (let i = 0; i < parallelBrowsers; i++) {
            const browser = await getBrowser();
            browsers.push(browser);
        }

        // Create all promises for parallel processing
        for (let i = 0; i < matchUps.length; i++) {
            const game = matchUps[i];
            const browser = browsers[i % parallelBrowsers];
            
            promises.push(
                (async () => {
                    const page = await getPage(browser);
                    try {
                        return await getPitcherStats(page, game, browser);
                    } catch (error) {
                        console.error(`Error processing game ${game.matchLink}:`, error.message);
                        return null;
                    } finally {
                        releasePage(page);
                    }
                })()
            );
        }
        
        // Wait for all promises to complete
        const results = await Promise.all(promises);
        // Filter out null results before flattening
        const validResults = results.filter(result => result !== null);
        pitcherStats = pitcherStats.concat(validResults.flat());

        // Release all browsers
        for (const browser of browsers) {
            releaseBrowser(browser);
        }

        // Save the results
        const output = JSON.stringify(pitcherStats, null, 2);
        fs.writeFileSync('pitcher_stats.json', output);

        // Clean up
        while (browserPool.length > 0) {
            const browser = browserPool.pop();
            await browser.close();
        }
        
        console.log("Pitcher stats scraping completed!");
        process.exit(0);
    } catch (error) {
        console.error('An error occurred:', error.message);
        process.exit(1);
    }
}

processGames(); 