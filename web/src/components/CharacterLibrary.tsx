import { Lock, Unlock } from "lucide-react";
import type { Character } from "../domain/types";

interface CharacterLibraryProps {
  characters: Character[];
}

export function CharacterLibrary({ characters }: CharacterLibraryProps) {
  return (
    <section className="review-section" aria-label="Character library">
      <div className="section-heading">
        <h2>Characters</h2>
        <span>{characters.length}</span>
      </div>
      <div className="character-list">
        {characters.length === 0 ? (
          <p className="empty-state">No characters yet.</p>
        ) : (
          characters.map((character) => (
            <article className="character-card" key={character.id}>
              <div className="character-swatch" aria-hidden="true">
                {character.name.slice(0, 1)}
              </div>
              <div>
                <div className="character-title">
                  <h3>{character.name}</h3>
                  {character.locked ? <Lock aria-hidden="true" size={14} /> : <Unlock aria-hidden="true" size={14} />}
                </div>
                <p>{character.role}</p>
                <small>{character.visual_lock}</small>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
