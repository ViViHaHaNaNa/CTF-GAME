import type { AbilityId, CommanderWeapon, PostType, RaiderKind } from '@siege/shared';

// The game's display text and icons (UI only). Designers: change wording and icons here; nothing in
// here changes how the game plays. The game logic (shared/, server/) only knows ids.

export const POST_NAME: Record<PostType, string> = { pistol: 'Pistol post', gun: 'Gun post', shotgun: 'Shotgun post' };
export const RAIDER_NAME: Record<RaiderKind, string> = { r_bat: 'Bat', r_pistol: 'Pistol', r_helmet: 'Brute', r_shotgun: 'Shotgun' };
export const WEAPON_NAME: Record<CommanderWeapon, string> = { pistol: 'Pistol', gun: 'Gun', shotgun: 'Shotgun' };
export const POWER_NAME: Record<AbilityId, string> = { airstrike: 'Airstrike', molotov: 'Molotov', squad: 'Squad member', ultimate: 'Carpet bomb' };
export const SIDE_LABEL = ['north', 'east', 'south', 'west'];

/** Powers past the starting pistol, as the Main Tower card and the "New power unlocked!" card show them. */
export const POWER_COPY: Record<CommanderWeapon | AbilityId, { name: string; icon: string; desc: string }> = {
  pistol: { name: 'Pistol', icon: '🔫', desc: 'The Commander starts with it.' },
  gun: { name: 'Gun', icon: '🔫', desc: 'Harder hits and a 24-round magazine for the Commander.' },
  shotgun: { name: 'Shotgun', icon: '💥', desc: 'Five pellets a shot: shreds crowds up close.' },
  airstrike: { name: 'Airstrike', icon: '✈', desc: 'Tap ✈ then a spot: a bomb flattens a whole clump.' },
  molotov: { name: 'Molotov', icon: '🔥', desc: 'Tap 🔥 then a spot: a fire that burns and slows zombies.' },
  squad: { name: 'Squad member', icon: '🪖', desc: 'Summon a survivor from your raider roster; tap or drag to send them.' },
  ultimate: { name: 'Carpet bomb', icon: '💣', desc: 'Your ultimate: bombs every zombie around your base.' },
};

/** The basic-base checklist (guidance), by objective id (shared/src/economy.ts BASIC_BASE decides when each is done). */
export const OBJECTIVE_LABEL: Record<string, string> = {
  post: 'Buy your first post',
  slots: 'Fill both starter post slots',
  hq: 'Upgrade the Main Tower to level 2',
  postUp: 'Upgrade a post',
  walls: 'Upgrade the walls',
};

/** The walkthrough's coach prompts (step 1..4). */
export const COACH = [
  '',
  'Tap the zombies to shoot them!',
  'Nice shooting! Keep tapping, your posts help too.',
  'Held! Now buy a post: tap a glowing + slot in your base.',
  "You're ready. Watch the arrows: they show where the next surge comes from.",
];
