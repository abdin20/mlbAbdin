const puppeteer = require('puppeteer');
const fs = require('fs');

function capitalizeWords(str) {
    return str.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

async function getTodaysMatches() {
    const teams = {};
    const matchUps = [];

    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto('https://www.espn.com/mlb/schedule');

    const result = await page.evaluate(() => {
        const todayDateString = new Date().toDateString();

        const sections = document.querySelectorAll('.Table__Title');
        let data = [];
        sections.forEach(section => {
            const dateStr = section.textContent || "";
            const parsedDate = new Date(dateStr);
            if (parsedDate.toDateString() === todayDateString) {
                const rows = section.parentElement.querySelectorAll('.Table__TR--sm');
                rows.forEach(row => {
                    const awayTeamElement = row.querySelector('.Table__Team.away a.AnchorLink');
                    const awayTeamLogo = row.querySelector('.Table__Team.away img.Image');
                    const homeTeamElement = row.querySelector('.Table__Team:not(.away) a.AnchorLink');
                    const homeTeamLogo = row.querySelector('.Table__Team:not(.away) img.Image');
                    const matchLinkElement = row.querySelector('.date__col.Table__TD a.AnchorLink');

                    if (awayTeamElement && homeTeamElement && matchLinkElement) {
                        data.push({
                            awayTeamUrl: awayTeamElement.href,
                            awayTeamLogo: awayTeamLogo.src,
                            homeTeamUrl: homeTeamElement.href,
                            homeTeamLogo: homeTeamLogo.src,
                            matchLink: matchLinkElement.href
                        });
                    }
                });
            }
        });
        return data;
    });

    // Process the results
    result.forEach(r => {
        const awayTeamCode = r.awayTeamUrl.split('/').slice(-2, -1)[0];
        const awayTeamName = capitalizeWords(r.awayTeamUrl.split('/').pop().replace(/-/g, ' '));
        const homeTeamCode = r.homeTeamUrl.split('/').slice(-2, -1)[0];
        const homeTeamName = capitalizeWords(r.homeTeamUrl.split('/').pop().replace(/-/g, ' '));

        // Add to teams object
        teams[awayTeamCode] = awayTeamName;
        teams[homeTeamCode] = homeTeamName;

        // Add to matchUps array
        matchUps.push({
            awayTeam: {
                code: awayTeamCode,
                name: awayTeamName,
                logoUrl: r.awayTeamLogo
            },
            homeTeam: {
                code: homeTeamCode,
                name: homeTeamName,
                logoUrl: r.homeTeamLogo
            },
            matchLink: r.matchLink
        });
    });

    await browser.close();

    fs.writeFileSync('teams.json', JSON.stringify(teams, null, 4));
    console.log('Teams saved to teams.json');
    fs.writeFileSync('matchUps.json', JSON.stringify(matchUps, null, 4));
    console.log('Match ups saved to matchUps.json');
}

// getTodaysMatches()
module.exports = getTodaysMatches;
