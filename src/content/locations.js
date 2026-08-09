/**
 * Locations for ODD ONE OUT.
 *
 * Original work. The published Spyfall location list is a creative
 * compilation and is the protectable part of that product — mechanics are
 * free, curated lists are not. Every location and role below was written for
 * this platform.
 *
 * Each entry: [name, ...8 roles]. Eight roles so a 12-player table never
 * duplicates. Each list deliberately mixes insiders, specialists, and one
 * outsider/visitor — the outsider is doing real design work, because it gives
 * an ignorant-sounding player cover and keeps the spy alive longer.
 */

const RAW = [
  ['Volcano Observatory', 'Seismologist', 'Gas Sampler', 'Helicopter Pilot', 'Evacuation Officer', 'Data Technician', 'Visiting Journalist', 'Camp Cook', 'Cable Repair Engineer'],
  ['Ice Hotel', 'Ice Sculptor', 'Night Receptionist', 'Honeymooning Guest', 'Sled Dog Handler', 'Thermal Suit Attendant', 'Bar Manager', 'Snow Groomer Driver', 'Travel Photographer'],
  ['Dog Grooming Salon', 'Head Groomer', 'Nervous Owner', 'Apprentice Bather', 'Receptionist', 'Parcel Courier', 'Visiting Show Judge', 'Nail Trimmer', 'Resident Shop Cat'],
  ['Antique Auction House', 'Auctioneer', 'Absentee Bidder', 'Appraiser', 'Lot Porter', 'Rival Dealer', 'Catalogue Photographer', 'Security Guard', 'Nervous Seller'],
  ['Overnight Bakery', 'Head Baker', 'Dough Mixer', 'Delivery Driver', 'Apprentice', 'Oven Mechanic', 'Health Inspector', 'First Customer of the Day', 'Flour Supplier'],
  ['Mountain Rescue Hut', 'Team Leader', 'Stretcher Bearer', 'Radio Operator', 'Lost Hiker', 'Search Dog Handler', 'Weather Watcher', 'Helicopter Winchman', 'Hut Warden'],
  ['Karaoke Bar', 'Song Host', 'Tone-Deaf Regular', 'Bartender', 'Birthday Guest', 'Sound Technician', 'Reluctant Duet Partner', 'Doorman', 'Someone Still Waiting Their Turn'],
  ['Botanical Greenhouse', 'Head Gardener', 'Orchid Specialist', 'School Group Guide', 'Irrigation Engineer', 'Seed Bank Curator', 'Butterfly Keeper', 'Wedding Photographer', 'Volunteer Weeder'],
  ['Car Wash', 'Machine Operator', 'Impatient Driver', 'Vacuum Attendant', 'Wax Specialist', 'Coin Machine Repairman', 'Owner', 'Detailing Trainee', 'Lost Tourist'],
  ['Recycling Sorting Plant', 'Conveyor Sorter', 'Crane Operator', 'Safety Inspector', 'Magnet Technician', 'Scrap Buyer', 'School Tour Guide', 'Night Watchman', 'Compactor Driver'],
  ['Ferris Wheel', 'Ride Operator', 'Stuck Passenger', 'Maintenance Engineer', 'Ticket Seller', 'Someone About to Propose', 'Queue Marshal', 'Souvenir Photographer', 'Nervous First-Timer'],
  ['Scuba Diving Boat', 'Dive Master', 'Boat Captain', 'Beginner Diver', 'Underwater Photographer', 'Tank Filler', 'Marine Biologist', 'Deckhand', 'Seasick Passenger'],
  ['Laundromat', 'Change Machine Attendant', 'Regular With Ten Bags', 'Broke Student', 'Dryer Repairman', 'Owner', 'Person Missing One Sock', 'Reader of a Long Novel', 'Late-Night Stranger'],
  ['Falconry Centre', 'Master Falconer', 'Apprentice', 'Bird Vet', 'Glove Maker', 'School Group Teacher', 'Ticket Seller', 'Meat Supplier', 'Chaser of an Escaped Hawk'],
  ['Boxing Gym', 'Head Coach', 'Amateur Fighter', 'Cutman', 'Sparring Partner', 'Bag Repair Guy', 'Ring Announcer', 'Trial-Class Beginner', 'Timekeeper'],
  ['Planetarium', 'Projectionist', 'Astronomer Lecturer', 'School Chaperone', 'Sleeping Visitor', 'Sound Engineer', 'Gift Shop Clerk', 'Dome Cleaner', 'Star Chart Illustrator'],
  ['Wind Farm', 'Turbine Climber', 'Grid Controller', 'Bird Survey Ecologist', 'Drone Blade Inspector', 'Site Manager', 'Farmer Who Leases the Land', 'Crane Driver', 'Safety Trainer'],
  ['Bowling Alley', 'Lane Attendant', 'League Champion', 'Shoe Rental Clerk', 'Birthday Party Parent', 'Pin Machine Mechanic', 'Snack Bar Cook', 'First-Time Bowler', 'Scoreboard Fixer'],
  ['Puppet Workshop', 'Master Puppeteer', 'String Maker', 'Woodcarver', 'Costume Sewer', 'Touring Manager', 'Visiting Child', 'Voice Actor', 'Marionette Repairer'],
  ['Chess Tournament Hall', 'Grandmaster', 'Arbiter', 'Clock Setter', 'Nervous Junior Player', 'Live Commentator', 'Silent Spectator', 'Score Sheet Collector', 'Coffee Volunteer'],
  ['Farmers Market', 'Vegetable Stallholder', 'Cheese Seller', 'Busker', 'Market Inspector', 'Regular Shopper', 'Honey Producer', 'Parking Warden', 'Free-Sample Hunter'],
  ['Safari Jeep', 'Guide', 'Driver', 'Wildlife Photographer', 'Nervous Tourist', 'Tracker', 'Ranger With a Radio', 'Child on Their First Trip', 'Camp Cook'],
  ['Ski Lift Station', 'Lift Operator', 'Ski Instructor', 'Snow Patroller', 'Nervous Beginner', 'Ticket Inspector', 'Cable Mechanic', 'Hot Drinks Vendor', 'Snowboarder Who Hates Lifts'],
  ['Tattoo Studio', 'Tattoo Artist', 'First-Timer', 'Apprentice', 'Piercer', 'Receptionist', 'Cover-Up Client', 'Ink Supplier', 'Friend Holding Someone’s Hand'],
  ['Fireworks Factory', 'Pyrotechnician', 'Quality Tester', 'Safety Officer', 'Packer', 'Warehouse Driver', 'Colour Chemist', 'Display Designer', 'Apprentice Who Sneezes a Lot'],
  ['Hot Air Balloon', 'Pilot', 'Burner Operator', 'Chase Crew Driver', 'Anniversary Couple', 'Photographer', 'Weather Advisor', 'Terrified Passenger', 'Ground Anchor Holder'],
  ['Lighthouse', 'Keeper', 'Lamp Engineer', 'Supply Boat Skipper', 'Historian on a Tour', 'Seabird Ringer', 'Radio Operator', 'Tower Painter', 'The Keeper’s Cat'],
  ['Newspaper Newsroom', 'Editor-in-Chief', 'Junior Reporter', 'Photo Desk Chief', 'Fact Checker', 'Print Room Liaison', 'Sports Columnist', 'IT Support', 'Sandwich Delivery Person'],
  ['Cheese Ageing Cellar', 'Cheesemaker', 'Wheel Turner', 'Humidity Technician', 'Buyer for a Shop', 'Apprentice', 'Health Inspector', 'Cellar Cat', 'Tour Guide'],
  ['Cable Car', 'Cabin Attendant', 'Terrified Passenger', 'Maintenance Engineer', 'Tour Guide', 'Station Master', 'Window Cleaner', 'Photographer', 'Child Pressing Every Button'],
  ['Fish Market', 'Auction Caller', 'Ice Shoveller', 'Restaurant Buyer', 'Fisherman Unloading', 'Scale Cleaner', 'Market Inspector', 'Gull Chaser', 'Tourist Taking Photos'],
  ['Escape Room', 'Game Master', 'Panicking Player', 'Puzzle Designer', 'Actor in Costume', 'Camera Monitor', 'Birthday Group Leader', 'Room Resetter', 'Locksmith'],
  ['Silent Meditation Retreat', 'Retreat Leader', 'First-Time Attendee', 'Bell Ringer', 'Cook', 'Person Who Keeps Whispering', 'Grounds Keeper', 'Long-Term Resident', 'Late Arrival'],
  ['Reptile House', 'Keeper', 'Feeding Assistant', 'Vet', 'School Group Teacher', 'Glass Cleaner', 'Heat Lamp Technician', 'Nervous Visitor', 'Escape Investigator'],
  ['Rooftop Swimming Pool', 'Lifeguard', 'Towel Attendant', 'Cocktail Waiter', 'Determined Sunbather', 'Pool Cleaner', 'Hotel Manager', 'Swimming Coach', 'Person Who Cannot Swim'],
  ['Audiobook Recording Booth', 'Narrator', 'Sound Engineer', 'Director', 'Author Observing', 'Coffee Runner', 'Proofreader Listening Along', 'Air Conditioning Repairman', 'Neighbour Complaining About Noise'],
  ['Archaeological Dig', 'Site Director', 'Trench Digger', 'Finds Photographer', 'Student Volunteer', 'Local Landowner', 'Conservator', 'Drone Surveyor', 'Sceptical Journalist'],
  ['Ice Rink', 'Figure Skating Coach', 'Ice Resurfacer Driver', 'Skate Rental Clerk', 'Wobbly Beginner', 'Hockey Player', 'Music Operator', 'First Aid Attendant', 'Birthday Party Host'],
  ['Water Treatment Plant', 'Plant Operator', 'Water Quality Chemist', 'Pump Engineer', 'Tour Group Teacher', 'Night Supervisor', 'Pipe Inspector', 'Safety Officer', 'Chemical Delivery Driver'],
  ['Guitar Workshop', 'Luthier', 'Apprentice', 'Customer Trying Every Guitar', 'String Supplier', 'Repair Specialist', 'Timber Buyer', 'Touring Musician', 'Workshop Dog'],
  ['Hedge Maze', 'Gardener', 'Thoroughly Lost Family', 'Maze Designer', 'Ticket Seller', 'Steward on a Ladder', 'Wedding Photographer', 'Child Who Refuses to Leave', 'Drone Operator'],
  ['Blood Donation Van', 'Nurse', 'First-Time Donor', 'Registration Clerk', 'Driver', 'Biscuit and Juice Volunteer', 'Regular Donor', 'Fainting Watcher', 'Lab Courier'],
  ['Amusement Arcade', 'Change Booth Clerk', 'Claw Machine Addict', 'Machine Technician', 'Prize Counter Attendant', 'High-Score Legend', 'Cleaner', 'Birthday Group Ringleader', 'Someone Waiting for a Friend'],
  ['Cooking Competition Kitchen', 'Head Judge', 'Nervous Contestant', 'Sous Chef Assistant', 'Timekeeper', 'Camera Operator', 'Ingredient Runner', 'Spill Cleaner', 'Presenter'],
  ['Offshore Oil Rig', 'Drill Supervisor', 'Roughneck', 'Helicopter Pilot', 'Galley Cook', 'Safety Officer', 'Radio Operator', 'Saturation Diver', 'Geologist'],
  ['Village Post Office', 'Postmaster', 'Regular Pensioner', 'Delivery Rider', 'Stamp Collector', 'Parcel Sorter', 'Shop Assistant', 'Person Posting Something Suspicious', 'Queue Complainer'],
  ['Glassblowing Studio', 'Master Glassblower', 'Apprentice Gatherer', 'Furnace Technician', 'Gallery Buyer', 'Workshop Student', 'Kiln Loader', 'Tour Guide', 'Safety Goggle Enforcer'],
  ['Emergency Call Centre', 'Call Handler', 'Shift Supervisor', 'Dispatcher', 'Trainee With a Headset', 'IT Technician', 'Translator on Standby', 'Wellbeing Counsellor', 'Night Shift Cleaner'],
  ['Show Cave', 'Cave Guide', 'Lighting Technician', 'Geologist', 'Claustrophobic Visitor', 'Bat Researcher', 'Ticket Seller', 'Safety Rope Inspector', 'Souvenir Rock Seller'],
  ['Perfume Laboratory', 'Master Perfumer', 'Nose in Training', 'Lab Technician', 'Bottle Designer', 'Marketing Visitor', 'Ingredient Buyer', 'Cleaner Who Smells Everything', 'Quality Control Tester'],
  ['Airport Baggage Hall', 'Belt Loader', 'Lost Luggage Clerk', 'Customs Officer', 'Exhausted Passenger', 'Sniffer Dog Handler', 'Trolley Collector', 'Airline Supervisor', 'Person Waiting for a Very Large Box'],
  ['Community Radio Station', 'Morning Host', 'Sound Engineer', 'Phone-In Caller', 'Station Manager', 'Traffic Reporter', 'Volunteer Intern', 'Local Band in for a Session', 'Advertising Salesperson'],
  ['Wax Museum', 'Sculptor', 'Ticket Seller', 'Security Guard', 'Tour Guide', 'Cleaner Who Dusts Faces', 'Celebrity Lookalike', 'Lighting Technician', 'Child Who Touched Everything'],
  ['Marathon Finish Line', 'Race Director', 'Exhausted Runner', 'Medal Hander', 'Medical Volunteer', 'Timing Chip Technician', 'Commentator', 'Barrier Steward', 'Water Station Refiller'],
  ['Rooftop Apiary', 'Beekeeper', 'Hive Inspector', 'Honey Buyer', 'Rooftop Gardener', 'Building Superintendent', 'Allergic Intern', 'Documentary Filmmaker', 'Swarm Chaser'],
  ['Data Centre', 'Rack Technician', 'Badge Desk Guard', 'Cooling Engineer', 'On-Call Night Ops', 'Cable Installer', 'Compliance Auditor', 'Delivery Driver', 'Fire Suppression Inspector'],
  ['Livestock Auction', 'Auctioneer', 'Ring Handler', 'Cattle Buyer', 'Ranch Owner', 'Brand Inspector', 'Concession Cook', 'Youth Club Kid', 'Large Animal Vet'],
  ['Climbing Gym', 'Route Setter', 'Belay Instructor', 'Day-Pass Beginner', 'Front Desk Staff', 'Competition Judge', 'Physical Therapist', 'Chalk-Covered Regular', 'Harness Inspector'],
  ['Roller Derby Bout', 'Jammer', 'Blocker', 'Referee', 'Announcer', 'Track Medic', 'Merch Table Volunteer', 'Season Ticket Superfan', 'Penalty Box Timer'],
  ['Rare Books Room', 'Special Collections Librarian', 'Conservator', 'Visiting Researcher', 'Security Guard', 'Wealthy Donor', 'Digitisation Technician', 'Undergraduate on the Wrong Floor', 'Appraiser'],
];

export const LOCATIONS = RAW.map(([name, ...roles], i) => ({
  id: `loc${i}`,
  name,
  roles,
}));
