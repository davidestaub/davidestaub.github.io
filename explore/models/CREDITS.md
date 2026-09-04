# Ship model credits

## The ship the game draws

The player's ship is procedural: `explore/lib/ship-mesh.js` builds it at load
time (`makeShipMesh`, used by `loadShip`). No model file is shipped. The mesh,
its canvas textures and the drive effects are original work by Davide Staub
for this site and are released under CC0 1.0 (public domain); reuse them
freely, credit is welcome but not required.

Display scale: the hull is drawn 0.06 scene units long, which at the scene's
1 unit = 1,000 km would be a 60 km ship. That is a display size chosen so the
ship is visible next to planets, not a real size. The dossier should say the
ship is not to scale.

## Candidates that were evaluated and not used

Seven CC0 GLBs from poly.pizza were compared side by side in
`explore/lib/ship-preview.html` before the procedural route was taken. All
are low-poly stylised kits and read as toys rather than a believable
spacecraft, so none is shipped; they are not in the repository.

| poly.pizza id | title | author | licence | triangles |
| --- | --- | --- | --- | --- |
| Jqfed124pQ | Spaceship | Quaternius | CC0 1.0 | 2,814 |
| VSxUAFhzbA | Spaceship | Quaternius | CC0 1.0 | 3,376 |
| u105mYHLHU | Spaceship | Quaternius | CC0 1.0 | 6,208 |
| uCeLfsdmNP | Spaceship | Quaternius | CC0 1.0 | 1,614 |
| PQzePrvBCD | Spaceship | Quaternius | CC0 1.0 | 1,190 |
| DbGajMHrvp | Spaceship | Quaternius | CC0 1.0 | 628 |
| xNbtFQwirO | Spaceship | Quaternius | CC0 1.0 | 590 |

Source pages: `https://poly.pizza/m/<id>`. If one is ever brought back, put it
at `explore/models/ship.glb`, set `USE_GLB = true` in `ship-mesh.js`, and add
its line here.
