import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const output = fileURLToPath(new URL('./fixtures/', import.meta.url));
await mkdir(output, { recursive: true });
const points = [[0,0,0],[20,0,0],[20,30,0],[0,30,0],[0,0,10],[20,0,10],[20,30,10],[0,30,10]];
const faces = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
const facets = faces.flatMap(([a,b,c,d]) => [[a,b,c],[a,c,d]]);
const stl = Buffer.alloc(84 + facets.length * 50);
stl.write('Nine format fixture 20 x 30 x 10 mm');
stl.writeUInt32LE(facets.length, 80);
facets.forEach((triangle, index) => triangle.forEach((vertex, corner) => points[vertex].forEach((value, axis) => stl.writeFloatLE(value, 84 + index * 50 + 12 + corner * 12 + axis * 4))));
await writeFile(`${output}/cube-mm.stl`, stl);

const entities = [];
function entity(text) { entities.push(`#${entities.length + 1}=${text};`); return `#${entities.length}`; }
const application = entity("APPLICATION_CONTEXT('configuration controlled 3d designs of mechanical parts and assemblies')");
entity(`APPLICATION_PROTOCOL_DEFINITION('international standard','config_control_design',1994,${application})`);
const productContext = entity(`MECHANICAL_CONTEXT('',${application},'mechanical')`);
const product = entity(`PRODUCT('cube','20 x 30 x 10 mm cube','',(${productContext}))`);
const formation = entity(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',${product},.NOT_KNOWN.)`);
const definitionContext = entity(`PRODUCT_DEFINITION_CONTEXT('part definition',${application},'design')`);
const definition = entity(`PRODUCT_DEFINITION('design','',${formation},${definitionContext})`);
const shape = entity(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);
const length = entity('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
const angle = entity('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
const solidAngle = entity('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
const uncertainty = entity(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-7),${length},'distance_accuracy_value','')`);
const context = entity(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${length},${angle},${solidAngle}))REPRESENTATION_CONTEXT('',''))`);
const vertexIds = points.map((point) => entity(`CARTESIAN_POINT('',(${point.map((v) => `${v}.`).join(',')}))`));
const faceIds = faces.map((indices) => {
  const loop = entity(`POLY_LOOP('',(${indices.map((index) => vertexIds[index]).join(',')}))`);
  const bound = entity(`FACE_OUTER_BOUND('',${loop},.T.)`);
  const p = points[indices[0]], q = points[indices[1]], r = points[indices[2]];
  const a = q.map((value, i) => value - p[i]), b = r.map((value, i) => value - p[i]);
  const normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const normalId = entity(`DIRECTION('',(${normal.map((v) => `${v}.`).join(',')}))`);
  const referenceId = entity(`DIRECTION('',(${a.map((v) => `${v}.`).join(',')}))`);
  const axis = entity(`AXIS2_PLACEMENT_3D('',${vertexIds[indices[0]]},${normalId},${referenceId})`);
  const plane = entity(`PLANE('',${axis})`);
  return entity(`FACE_SURFACE('',(${bound}),${plane},.T.)`);
});
const shell = entity(`CLOSED_SHELL('',(${faceIds.join(',')}))`);
const brep = entity(`FACETED_BREP('cube',${shell})`);
const representation = entity(`FACETED_BREP_SHAPE_REPRESENTATION('',(${brep}),${context})`);
entity(`SHAPE_DEFINITION_REPRESENTATION(${shape},${representation})`);
const step = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Synthetic format fixture'),'2;1');\nFILE_NAME('cube-mm.step','2020-01-01T00:00:00',('Synthetic author'),('Example organization'),'Fixture generator','Fixture generator','');\nFILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));\nENDSEC;\nDATA;\n${entities.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
await writeFile(`${output}/cube-mm.step`, step);

const modelNS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const productionNS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
// ZIP stores local calendar fields. A fixed local date keeps bytes identical
// across both repeated runs and machines in different time zones.
const fixtureZipTime = new Date(2020, 0, 1, 0, 0, 0);
export const meshXML = (vertices = points, triangles = facets) => `<mesh><vertices>${vertices.map(([x,y,z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${triangles.map(([a,b,c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`;
export const modelXML = (resources, build, unit = 'millimeter') => `<?xml version="1.0"?><model xmlns="${modelNS}" xmlns:p="${productionNS}" unit="${unit}"><resources>${resources}</resources><build>${build}</build></model>`;
export function make3MF(models) {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ...models,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, strToU8(value)])), { mtime: fixtureZipTime });
}
await writeFile(`${output}/cube-mm.3mf`, make3MF({ '3D/3dmodel.model': modelXML(`<basematerials id="2"><base name="Mint" displaycolor="#79D6B4"/></basematerials><object id="1" name="Cube" pid="2" pindex="0">${meshXML()}</object>`, '<item objectid="1"/>') }));
await writeFile(`${output}/bambu-components.3mf`, make3MF({
  '3D/3dmodel.model': modelXML('<object id="1" name="Bambu component fixture"><components><component objectid="1" p:path="/3D/Objects/part-a.model"/><component objectid="1" p:path="/3D/Objects/part-b.model" transform="1 0 0 0 1 0 0 0 1 30 0 0"/></components></object>', '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 2 3"/>'),
  '3D/Objects/part-a.model': modelXML(`<object id="1" name="Part A">${meshXML()}</object>`, ''),
  '3D/Objects/part-b.model': modelXML(`<object id="1" name="Part B">${meshXML(points.map(([x,y,z]) => [x / 2, y / 2, z / 2]))}</object>`, ''),
}));
console.log(`Generated STL, STEP, 3MF and Bambu component fixtures in ${output}`);
