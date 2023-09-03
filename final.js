const puppeteer = require('puppeteer');
const fs = require('fs');
let highDueFactorPlayers = [];
let hotStreakPlayers = [];
const parallelPlayers = 4;
const parallelBrowsers = 2;



const browserPool = [];
const pagePool = [];


async function initialize() {
    for (let i = 0; i < parallelBrowsers; i++) {
        const browser = await puppeteer.launch({
            headless: "new"
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
    return browserPool.shift(); // Get the first browser and remove it from the pool
}

async function getPage(browser) {
    return new Promise(async (resolve) => {
        const checkPagePool = async () => {
            if (pagePool.length > 0) {
                resolve(pagePool.shift());
            } else {
                setTimeout(checkPagePool, 200); // Check every second
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

async function processPlayer(browser, playerID, rosterUrl) {
    const page = await getPage(browser);
    try {
        const playerUrl = `https://www.espn.com/mlb/player/gamelog/_/id/${playerID}`;
        await page.goto(playerUrl);

        const playerName = await page.$eval('h1.PlayerHeader__Name', el => {
            const firstName = el.querySelector('span:nth-child(1)').textContent.trim();
            const lastName = el.querySelector('span:nth-child(2)').textContent.trim();
            return `${firstName} ${lastName}`;
        });

        const hits = await page.$$eval('.Table__TBODY .Table__TR:not(.totals_row)', rows => {
            return rows.map(row => {
                const dateCell = row.querySelector('td:first-child');
                if (dateCell && !['totals', 'april', 'may', 'june', 'july', 'august', 'september', 'october'].includes(dateCell.textContent.toLowerCase())) {
                    const hitsCell = row.querySelector('.Table__TD:nth-child(6)');
                    return hitsCell ? parseInt(hitsCell.textContent) : null;
                }
                return null;
            }).filter(hit => hit !== null);
        });
        const playerData = await extractPlayerFeatures(page);
        const recentHits = hits.slice(0, 3);
        const regex = /team=([a-z]+)/;
        const match = rosterUrl.match(regex);
        if (recentHits.every(hit => hit === 0)) {
            const probabilities = calculateProbability(hits);
            if (probabilities.probability2 >= 50 || probabilities.probability3 >= 50) {
                return {
                    name: playerName,
                    recentHits: hits.slice(0, 10),
                    dueFactor2: probabilities.probability2,
                    "Occurences with 2 no hitters": probabilities.miss2HitGamesOccurences,
                    dueFactor3: probabilities.probability3,
                    "Occurences with 3 no hitters": probabilities.miss3HitGamesOccurences,
                    url: `https://www.espn.com/mlb/player/gamelog/_/id/${playerID}`,
                    Team: (match && match[1]) ? match[1] : ""
                };
            }
        }

        if (recentHits.every(hit => hit > 0)) {
            const probabilities = calculateProbability(hits);
            if (probabilities.hitStreak2 >= 50 || probabilities.hitStreak3 >= 50) {
                hotStreakPlayers.push({
                    name: playerName,
                    recentHits: hits.slice(0, 10),
                    "Continue 2 Hit Streak %": probabilities.hitStreak2,
                    "2 hit streak occcurences": probabilities.hitStreak2Games,
                    "Continue 3 Hit Streak %": probabilities.hitStreak3,
                    "3 hit streak occcurences": probabilities.hitStreak3Games,
                    url: `https://www.espn.com/mlb/player/gamelog/_/id/${playerID}`,
                    Team: (match && match[1]) ? match[1] : ""
                });
            }
        }

        return null;

    } finally {
        releasePage(page);
    }
}


async function processTeam(rosterUrl) {
    const browser = await getBrowser();
    try {
        console.log(`Processing roster: ${rosterUrl}`);
        const page = await getPage(browser);
        await page.goto(rosterUrl);

        const playerIDsSet = new Set(await page.$$eval('.ResponsiveTable:not(.Pitchers) a.AnchorLink[href*="/mlb/player/_/id/"]', links => links.map(link => link.href.split('/id/')[1].split('/')[0])));
        const playerIDs = [...playerIDsSet];
        await releasePage(page)
        for (let i = 0; i < playerIDs.length; i += parallelPlayers) {
            const promises = [];
            for (let j = 0; j < parallelPlayers && i + j < playerIDs.length; j++) {
                promises.push(processPlayer(browser, playerIDs[i + j], rosterUrl));
            }
            const results = await Promise.all(promises);
            highDueFactorPlayers = highDueFactorPlayers.concat(results.filter(result => result !== null));
        }
    } finally {
        releaseBrowser(browser);
    }
}



async function scrapeMLBStats() {
    try {
        await initialize();
        const browser = await puppeteer.launch({
            headless: "new"
        });
        const mainPage = await browser.newPage();
        await mainPage.setDefaultNavigationTimeout(0);
        await mainPage.goto('https://www.espn.com/mlb/players');
        const rosterUrls = await mainPage.$$eval('.mod-content ul li div[style="float:left;"] a', links => links.map(link => link.href));
        await browser.close();

        for (let i = 0; i < rosterUrls.length; i += parallelBrowsers) {
            const promises = [];
            for (let j = 0; j < parallelBrowsers && i + j < rosterUrls.length; j++) {
                promises.push(processTeam(rosterUrls[i + j]));
            }
            await Promise.all(promises);
        }
        highDueFactorPlayers.sort((a, b) => {
            if (b.dueFactor3 === a.dueFactor3) {
                return b.dueFactor2 - a.dueFactor2
            }
            return b.dueFactor3 - a.dueFactor3
        });

        hotStreakPlayers.sort((a, b) => {
            if (b['Continue 3 Hit Streak %'] === a['Continue 3 Hit Streak %']) {
                return b["Continue 2 Hit Streak %"] - a["Continue 2 Hit Streak %"]
            }
            return b['Continue 3 Hit Streak %'] - a['Continue 3 Hit Streak %']
        });
        console.log("Saving Data")
        const output = JSON.stringify(highDueFactorPlayers, null, 2); // The '2' here is for pretty-printing the JSON with 2 spaces indentation
        fs.writeFileSync('high_due_factor_players.json', output);

        const hotStreakOutput = JSON.stringify(hotStreakPlayers, null, 2); // The '2' here is for pretty-printing the JSON with 2 spaces indentation
        fs.writeFileSync('hot_streak_factor_players.json', hotStreakOutput);


        while (browserPool.length > 0) {
            const browser = browserPool.pop();
            await browser.close();
        }
        console.log("Done")
        process.exit(0);
    } catch (error) {
        console.error('An error occurred:', error.message);
        process.exit(1);
    }
}

const extractPlayerFeatures = async (page) => {
    return await page.$$eval('.Table__TBODY .Table__TR:not(.totals_row)', rows => {
        return rows.map(row => {
            const dateCell = row.querySelector('td:first-child');
            if (dateCell && !['totals', 'april', 'may', 'june', 'july', 'august', 'september', 'october'].includes(dateCell.textContent.toLowerCase())) {
                const getCellText = (selector) => {
                    const cell = row.querySelector(selector);
                    return cell ? cell.textContent : null;
                };
                const AB = parseInt(getCellText('.Table__TD:nth-child(4)'));
                const H = parseInt(getCellText('.Table__TD:nth-child(6)'));
                const AVG = parseFloat(getCellText('.Table__TD:nth-child(16)'));
                const OBP = parseFloat(getCellText('.Table__TD:nth-child(17)'));
                const SLG = parseFloat(getCellText('.Table__TD:nth-child(18)'));
                const HR = parseInt(getCellText('.Table__TD:nth-child(9)'));
                const RBI = parseInt(getCellText('.Table__TD:nth-child(10)'));
                const BB = parseInt(getCellText('.Table__TD:nth-child(11)'));
                return { AB, H, AVG, OBP, SLG, HR, RBI, BB };
            }
            return null;
        }).filter(data => data !== null);
    });
};

function predictHitProbability(playerData) {
    const recentGames = playerData.slice(0, 5);

    const totalAB = recentGames.reduce((sum, game) => sum + game.AB, 0);
    const totalH = recentGames.reduce((sum, game) => sum + game.H, 0);
    const totalHR = recentGames.reduce((sum, game) => sum + game.HR, 0);
    const avgOBP = recentGames.reduce((sum, game) => sum + game.OBP, 0) / 5;

    let probability = 0;

    const recentAVG = totalH / totalAB;

    if (recentAVG > 0.250 && totalAB >= 15) {
        probability += 0.4; // Increase by 40% if recent AVG is good and has had decent at-bats
    }

    if (avgOBP > 0.300) {
        probability += 0.3; // Increase by 30% if recent OBP is good
    }

    if (totalHR >= 1) {
        probability += 0.3; // Increase by 30% if has hit at least 1 home run in recent games
    }

    return Math.min(probability, 1) * 100; // Ensure probability doesn't exceed 100%
}



function calculateProbability(hits) {
    const hitOccurrences2 = hits.slice(2).filter((hit, index, arr) => {
        if (index < arr.length - 1) {
            return arr[index] > 0 && arr[index + 1] > 0;
        }
        return false;
    }).length;

    const hitsAfterHitStreak2 = hits.slice(2).filter((hit, index, arr) => {
        if (index < arr.length - 2) {
            return arr[index] > 0 && arr[index + 1] > 0 && arr[index + 2] > 0;
        }
        return false;
    }).length;
    const probabilityHiStreak2 = hitOccurrences2 === 0 ? 0 : (hitsAfterHitStreak2 / hitOccurrences2) * 100;



    // Calculate occurrences after 3 games with a hit
    const hitOccurrences3 = hits.slice(3).filter((hit, index, arr) => {
        if (index < arr.length - 2) {
            return arr[index] > 0 && arr[index + 1] > 0 && arr[index + 2] > 0;
        }
        return false;
    }).length;

    const hitsAfterHitStreak3 = hits.slice(3).filter((hit, index, arr) => {
        if (index < arr.length - 3) {
            return arr[index] > 0 && arr[index + 1] > 0 && arr[index + 2] > 0 && arr[index + 3] > 0;
        }
        return false;
    }).length;

    const probabilityHiStreak3 = hitOccurrences3 === 0 ? 0 : (hitsAfterHitStreak3 / hitOccurrences3) * 100;


    // Calculate occurrences after 2 games without a hit
    const occurrences2 = hits.slice(2).filter((hit, index, arr) => {
        if (index < arr.length - 1) {
            return arr[index] === 0 && arr[index + 1] === 0;
        }
        return false;
    }).length;

    const hitsAfterStreak2 = hits.slice(2).filter((hit, index, arr) => {
        if (index < arr.length - 2) {
            return arr[index] === 0 && arr[index + 1] === 0 && arr[index + 2] > 0;
        }
        return false;
    }).length;

    const probability2 = occurrences2 === 0 ? 0 : (hitsAfterStreak2 / occurrences2) * 100;

    // Calculate occurrences after 3 games without a hit
    const occurrences3 = hits.slice(3).filter((hit, index, arr) => {
        if (index < arr.length - 2) {
            return arr[index] === 0 && arr[index + 1] === 0 && arr[index + 2] === 0;
        }
        return false;
    }).length;

    const hitsAfterStreak3 = hits.slice(3).filter((hit, index, arr) => {
        if (index < arr.length - 3) {
            return arr[index] === 0 && arr[index + 1] === 0 && arr[index + 2] === 0 && arr[index + 3] > 0;
        }
        return false;
    }).length;

    const probability3 = occurrences3 === 0 ? 0 : (hitsAfterStreak3 / occurrences3) * 100;

    return {
        probability2: probability2,
        miss2HitGamesOccurences: occurrences2,
        probability3: probability3,
        miss3HitGamesOccurences: occurrences3,
        hitStreak2: probabilityHiStreak2,
        hitStreak2Games: hitOccurrences2,
        hitStreak3: probabilityHiStreak3,
        hitStreak3Games: hitOccurrences3


    };
}

const getTodaysMatches = require('./fetchPlayingGames');

getTodaysMatches().then(() => {
    console.log("Fetching completed!");
}).catch(error => {
    console.error("Error occurred:", error.message);
    process.exit(1);
});
scrapeMLBStats();
