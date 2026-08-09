/**
 * Concept pairs for SPECTRUM.
 *
 * Original work — the published Wavelength pair list is copyrightable
 * expression. Quality rules applied to every pair below: both poles must be
 * genuinely contested and culturally shared; anything with an objective
 * answer ("Small / Large") is cut; pure synonym-antonym pairs are cut. The
 * test is whether the pair produces an argument.
 */

const RAW = [
  ['Underrated', 'Overrated'], ['Cheap', 'Expensive'], ['Forgettable', 'Unforgettable'],
  ['A sad song', 'A happy song'], ['Round', 'Pointy'], ['Quiet', 'Loud'],
  ['Casual', 'Formal'], ['Fragile', 'Indestructible'], ['Guilty pleasure', 'Respectable taste'],
  ['Comfort food', 'Fancy food'], ['A bad habit', 'A good habit'], ['A waste of time', 'Time well spent'],
  ['A rip-off', 'Great value'], ['An everyday object', 'A luxury object'], ['Ugly', 'Beautiful'],
  ['A boring job', 'An exciting job'], ['Small talk', 'A deep conversation'], ['Cold', 'Hot'],
  ['A mild flavour', 'An intense flavour'], ['For kids', 'For adults'], ['Easy to fake', 'Impossible to fake'],
  ['Effortless', 'Takes years of practice'], ['Old-fashioned', 'Futuristic'], ['Rural', 'Urban'],
  ['A lazy gift', 'A thoughtful gift'], ['Rude', 'Polite'], ['Temporary', 'Permanent'],
  ['A common name', 'An unusual name'], ['An indoor thing', 'An outdoor thing'], ['Better alone', 'Better in a group'],
  ['Slow', 'Fast'], ['A trivial problem', 'A serious problem'], ['An understandable mistake', 'An unforgivable mistake'],
  ['An ordinary skill', 'A superpower'], ['A want', 'A need'], ['A snack', 'A meal'],
  ['Advice you ignore', 'Advice you follow'], ['A toy', 'A tool'], ['Awkward silence', 'Comfortable silence'],
  ['A fashion mistake', 'Timeless style'], ['A bad smell', 'A good smell'], ['Feels forbidden', 'Feels wholesome'],
  ['A guilty secret', 'Something you brag about'], ['A cheap thrill', 'A life-changing experience'],
  ['Easy to explain', 'Impossible to explain'], ['Wet', 'Dry'], ['Soft', 'Hard'],
  ['An ordinary Tuesday', 'Once in a lifetime'], ['Rough', 'Smooth'], ['Local', 'Global'],
  ['Cheap to make', 'Expensive to make'], ['Background music', 'Music you sit down and listen to'],
  ['Bland', 'Spicy'], ['Tacky', 'Elegant'], ['A trend', 'A tradition'], ['A chore', 'A treat'],
  ['Something you put off', 'Something you rush to do'], ['A sensible purchase', 'An impulse buy'],
  ['Easy to start', 'Hard to finish'], ['Cute', 'Terrifying'], ['A toy for a child', 'A collector’s item'],
  ['An overreaction', 'An underreaction'], ['A phase', 'A personality'], ['Antisocial', 'Sociable'],
  ['A cheap material', 'A precious material'], ['A weekday thing', 'A weekend thing'],
  ['A quick fix', 'A real solution'], ['A hobby', 'An obsession'], ['A practical gift', 'A romantic gift'],
  ['Modest', 'Show-off'], ['Dangerous', 'Completely safe'], ['Silly', 'Serious'],
  ['Spotless', 'Filthy'], ['Dated technology', 'Cutting-edge technology'],
  ['Something you’d hide', 'Something you’d display'], ['Impossible to ruin', 'Ruined by one mistake'],
  ['A budget holiday', 'A dream holiday'], ['Suspicious', 'Trustworthy'], ['Unhealthy', 'Healthy'],
  ['Guilty', 'Innocent'], ['Amateur', 'Professional'], ['Everyday courage', 'Genuine heroism'],
  ['Chaotic', 'Immaculately organised'], ['Something you’d lend out', 'Something you’d never lend out'],
  ['An ordinary talent', 'A rare talent'], ['A loud colour', 'A subtle colour'], ['Blends in', 'Stands out'],
  ['Painful', 'Pleasant'], ['A tourist trap', 'Worth the trip'], ['Learn it once', 'Practise it forever'],
  ['A guideline', 'An unbreakable rule'], ['Selfish', 'Selfless'], ['Weird', 'Completely normal'],
  ['Cheap to fix', 'Just throw it away'], ['Superstition', 'Common sense'],
  ['Feels like it drags', 'Feels like it flies by'], ['Pure hard work', 'Pure luck'],
  ['A necessary evil', 'Pure joy'], ['Ordinary weather', 'Extreme weather'], ['The underdog', 'The favourite'],
  ['Timid', 'Bold'], ['A cheap laugh', 'A clever joke'], ['Something you tolerate', 'Something you love'],
  ['A beginner’s mistake', 'An expert’s mistake'], ['Hard to pronounce', 'Easy to pronounce'],
  ['Would last a week', 'Would last a century'], ['Something you buy', 'Something you rent'],
  ['Kept in a drawer', 'Kept on a shelf'], ['A cold-weather thing', 'A hot-weather thing'],
  ['Public behaviour', 'Private behaviour'], ['Overdressed', 'Underdressed'],
  ['A hobby your parents approve of', 'A hobby your parents worry about'], ['A cheap date', 'An expensive date'],
  ['Wholesome', 'Sinister'], ['Predictable', 'Genuinely surprising'], ['Fits in a pocket', 'Needs a truck'],
  ['Something you’d delegate', 'Something you’d insist on doing yourself'],
  ['Instantly satisfying', 'Slowly rewarding'], ['A problem for me', 'A problem for everyone'],
  ['Smells artificial', 'Smells natural'], ['Cautious', 'Reckless'],
  ['Something you’d post online', 'Something you’d keep offline'],
  ['Would make a great pet', 'Would make a terrible pet'], ['A learned skill', 'A natural talent'],
  ['Plans everything', 'Improvises everything'], ['Fine on your own', 'Needs company'],
  ['A warm colour', 'A cool colour'], ['Scratchy fabric', 'Luxurious fabric'], ['Easy to say', 'Hard to say'],
  ['An old person’s thing', 'A young person’s thing'], ['Would ruin a first date', 'Would make a first date'],
  ['Underground', 'Mainstream'], ['Fake', 'Authentic'], ['Belongs in a museum', 'Belongs in a bin'],
  ['Whispered', 'Shouted'], ['Embarrassed about it', 'Proud of it'], ['A cheap trick', 'Real magic'],
  ['Sounds fun, actually awful', 'Sounds awful, actually fun'],
  ['Would survive the apocalypse', 'Would not last a day'],
  ['Not worth arguing about', 'Worth ending a friendship over'], ['Feels cheap', 'Feels premium'],
  ['A snack you share', 'A snack you hide'], ['Fixes itself', 'Needs an expert'],
  ['Understated', 'Dramatic'], ['Something you grow out of', 'Something you grow into'],
  ['A mild inconvenience', 'A ruined day'], ['Would be forgiven', 'Would never be forgiven'],
  ['Better in theory', 'Better in practice'],
];

export const SPECTRUMS = RAW.map(([low, high], i) => ({ id: `sp${i}`, low, high }));
