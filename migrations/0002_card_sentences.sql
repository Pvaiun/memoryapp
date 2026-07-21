-- Descent card redesign: the Brain writes the card's face as one marked-up
-- sentence (**bold** tokens, [label](itemId) chips); nudge bubbles carry a
-- single first-step ledge action. `reason` stays as the stripped plain text.
ALTER TABLE bubbles ADD COLUMN sentence TEXT NOT NULL DEFAULT '';
ALTER TABLE bubbles ADD COLUMN first_step TEXT;
