import ForEach from "../ThirdParty/GltfPipeline/ForEach.js";
import WebGLConstants from "../Core/WebGLConstants.js";
import defined from "../Core/defined.js";
import Cartesian3 from "../Core/Cartesian3.js";
import ModelOutlineGenerationMode from "../Scene/ModelOutlineGenerationMode.js";

// glTF does not allow an index value of 65535 because this is the primitive
// restart value in some APIs.
var MAX_GLTF_UINT16_INDEX = 65534;
function ModelOutlineGenerator() {}

/**
 * Determines which edges in a model should be outlined.
 * It does this by adding the index buffer expected by CESIUM_primitive_outline
 * extension that determines which edges to outline.
 *
 * Note that this is reasonably performance expensive, and not recommended for
 * use on large meshes.
 * @returns true if there are edges to outline, false otherwise.
 * @private
 */
ModelOutlineGenerator.generateOutlinesForModel = function (model) {
  if (
    defined(model.extensionsRequired.KHR_draco_mesh_compression) ||
    defined(model.extensionsUsed.KHR_draco_mesh_compression)
  ) {
    // Draco compressed meshes are not supported
    return false;
  }

  var gltf = model.gltf;
  var outlineAny = false;
  ForEach.mesh(gltf, function (mesh, meshId) {
    ForEach.meshPrimitive(mesh, function (_primitive, primitiveId) {
      outlineAny = outlinePrimitive(model, meshId, primitiveId) || outlineAny;
    });
  });
  return outlineAny;
};

function outlinePrimitive(model, meshId, primitiveId) {
  var gltf = model.gltf;
  var mesh = gltf.meshes[meshId];
  var primitive = mesh.primitives[primitiveId];
  var accessors = gltf.accessors;
  var bufferViews = gltf.bufferViews;
  var triangleIndexAccessorGltf = accessors[primitive.indices];
  var triangleIndexBufferViewGltf;
  var indexedTriangleMode = false;
  if (defined(triangleIndexAccessorGltf)) {
    triangleIndexBufferViewGltf =
      bufferViews[triangleIndexAccessorGltf.bufferView];
    indexedTriangleMode = true;
  }
  var positionAccessorGltf = accessors[primitive.attributes.POSITION];
  var positionBufferViewGltf = bufferViews[positionAccessorGltf.bufferView];
  var normalAccessorGltf = accessors[primitive.attributes.NORMAL];
  if (!defined(normalAccessorGltf)) {
    // Can't outline this model because it has no normals
    return false;
  }
  var normalBufferViewGltf = bufferViews[normalAccessorGltf.bufferView];

  if (!defined(normalBufferViewGltf.byteStride)) {
    normalBufferViewGltf.byteStride = Float32Array.BYTES_PER_ELEMENT * 3;
  }
  if (!defined(positionBufferViewGltf.byteStride)) {
    positionBufferViewGltf.byteStride = Float32Array.BYTES_PER_ELEMENT * 3;
  }

  var loadResources = model._loadResources;

  var triangleIndexBufferView;
  if (indexedTriangleMode) {
    triangleIndexBufferView = loadResources.getBuffer(
      triangleIndexBufferViewGltf
    );
  }

  var positionBufferView = loadResources.getBuffer(positionBufferViewGltf);
  var positions = new Float32Array(
    positionBufferView.buffer,
    positionBufferView.byteOffset + positionAccessorGltf.byteOffset,
    positionBufferViewGltf.length
  );

  var normalBufferView = loadResources.getBuffer(normalBufferViewGltf);
  var normals = new Float32Array(
    normalBufferView.buffer,
    normalBufferView.byteOffset + normalAccessorGltf.byteOffset,
    normalBufferViewGltf.length
  );
  var vertexNormalGetter = generateVertexAttributeGetter(
    normals,
    normalBufferViewGltf.byteStride / Float32Array.BYTES_PER_ELEMENT
  );

  var triangleIndices;
  if (indexedTriangleMode) {
    triangleIndices =
      triangleIndexAccessorGltf.componentType === WebGLConstants.UNSIGNED_SHORT
        ? new Uint16Array(
            triangleIndexBufferView.buffer,
            triangleIndexBufferView.byteOffset +
              triangleIndexAccessorGltf.byteOffset,
            triangleIndexAccessorGltf.count
          )
        : new Uint32Array(
            triangleIndexBufferView.buffer,
            triangleIndexBufferView.byteOffset +
              triangleIndexAccessorGltf.byteOffset,
            triangleIndexAccessorGltf.count
          );
  }

  /*
   * To figure out which faces are adjacent in this mesh, we put its edges into a directed half edge map.
   *
   * The version used here is adapted from the one described in [this paper](https://www.graphics.rwth-aachen.de/media/papers/directed.pdf).
   *         A
   *        / ^
   *       /   \
   *      v  1  \
   *    B -----> C
   *      <-----
   *     \   2  ^
   *      \    /
   *       v  /
   *        D
   * Each face is represented by 3 directed half edges. For example, face 1 is made up of:
   * A -> B
   * B -> C
   * C -> A
   *
   * Each edge has a neighbor connecting the same vertices but in the opposite direction. In the diagram above, B->C's neighbor is C->B.
   * For each of a face's half edges, we can get its' neighbor, and therefore the face that neighbor belongs to.
   *
   */
  var halfEdgeMap = new Map();
  var vertexPositionGetter = generateVertexAttributeGetter(
    positions,
    positionBufferViewGltf.byteStride / Float32Array.BYTES_PER_ELEMENT
  );

  // Populate our half edge map
  if (indexedTriangleMode) {
    for (var i = 0; i < triangleIndexAccessorGltf.count; i += 3) {
      addTriangleToEdgeGraph(
        halfEdgeMap,
        undefined,
        i,
        triangleIndices,
        vertexPositionGetter
      );
    }
  } else {
    for (var j = 0; j < positionAccessorGltf.count; j += 3) {
      addTriangleToEdgeGraph(
        halfEdgeMap,
        j,
        undefined,
        undefined,
        vertexPositionGetter
      );
    }
  }

  var minimumAngle = defined(model.outlineGenerationMinimumAngle)
    ? model.outlineGenerationMinimumAngle
    : Math.PI / 20;

  if (
    defined(mesh.primitives[primitiveId].extensions) &&
    defined(mesh.primitives[primitiveId].extensions.CESIUM_primitive_outline) &&
    defined(
      mesh.primitives[primitiveId].extensions.CESIUM_primitive_outline
        .outlineWhenAngleBetweenFaceNormalsExceeds
    ) &&
    model.outlineGenerationMode === ModelOutlineGenerationMode.USE_GLTF_SETTINGS
  ) {
    minimumAngle =
      mesh.primitives[primitiveId].extensions.CESIUM_primitive_outline
        .outlineWhenAngleBetweenFaceNormalsExceeds;
  }

  var outlineIndexBuffer = findEdgesToOutline(
    halfEdgeMap,
    vertexNormalGetter,
    triangleIndices,
    minimumAngle
  );

  if (outlineIndexBuffer.length === 0) {
    //No edges to outline
    return false;
  }

  // Add new buffer to gltf
  var bufferId =
    gltf.buffers.push({
      byteLength: outlineIndexBuffer.byteLength,
      extras: {
        _pipeline: {
          source: outlineIndexBuffer.buffer,
        },
      },
    }) - 1;
  loadResources.buffers[bufferId] = outlineIndexBuffer;

  // Add new bufferview
  var bufferViewId =
    bufferViews.push({
      buffer: bufferId,
      byteOffset: 0,
      byteLength: outlineIndexBuffer.byteLength,
      target: WebGLConstants.ELEMENT_ARRAY_BUFFER,
    }) - 1;

  // Add new accessor
  var accessorId =
    accessors.push({
      bufferView: bufferViewId,
      byteOffset: 0,
      componentType:
        outlineIndexBuffer instanceof Uint16Array
          ? WebGLConstants.UNSIGNED_SHORT
          : WebGLConstants.UNSIGNED_INT,
      count: outlineIndexBuffer.length, // start and end for each line
    }) - 1;

  mesh.primitives[primitiveId].extensions = {
    CESIUM_primitive_outline: {
      indices: accessorId,
    },
  };
  gltf.extensionsUsed.push("CESIUM_primitive_outline");

  return true;
}

/**
 * Generates a function for getting the attributes of a vertex with a particular
 * index from a glTF vertex array
 * @private
 */
function generateVertexAttributeGetter(vertexArray, elementsPerVertex) {
  return function (index) {
    if (elementsPerVertex * index > vertexArray.length) {
      console.log("whoops");
    }
    return [
      vertexArray[elementsPerVertex * index],
      vertexArray[elementsPerVertex * index + 1],
      vertexArray[elementsPerVertex * index + 2],
    ];
  };
}

/**
 * Adds a single triangle to the directed half edge map.
 * @param {*} halfEdgeMap
 * @param {*} firstVertexIndex
 * @param {*} triangleStartIndex
 * @param {*} triangleIndices
 * @param {*} vertexPositionGetter
 * @private
 */
function addTriangleToEdgeGraph(
  halfEdgeMap,
  firstVertexIndex,
  triangleStartIndex, // in indexedTriangle mode, this is an index into the
  // index buffer.
  triangleIndices,
  vertexPositionGetter
) {
  var vertexIndexA, vertexIndexB, vertexIndexC;
  // Each vertex in the triangle
  if (defined(triangleStartIndex) && defined(triangleIndices)) {
    vertexIndexA = triangleIndices[triangleStartIndex];
    vertexIndexB = triangleIndices[triangleStartIndex + 1];
    vertexIndexC = triangleIndices[triangleStartIndex + 2];
  } else if (defined(firstVertexIndex)) {
    vertexIndexA = firstVertexIndex;
    vertexIndexB = firstVertexIndex + 1;
    vertexIndexC = firstVertexIndex + 2;
  } else {
    // throw new DeveloperError(
    //   "Either firstVertexIndex, or triangleStartIndex and triangleIndices, must be provided."
    // );
  }

  // For topologically "well behaved" meshes, adding half edges in both
  // directions isn't necessary-- every half-edge's twin exists in another face.
  // But in non-2-manifold meshes (where more than 2 faces share an edge), or
  // meshes with unconnected faces, this assumption doesn't hold.
  var edgePairs = [
    [vertexIndexA, vertexIndexB],
    [vertexIndexB, vertexIndexC],
    [vertexIndexC, vertexIndexA],
    [vertexIndexC, vertexIndexB],
    [vertexIndexB, vertexIndexA],
    [vertexIndexA, vertexIndexC],
  ];

  for (var i = 0; i < edgePairs.length; i++) {
    var pair = edgePairs[i];
    addHalfEdge(
      halfEdgeMap,
      vertexPositionGetter,
      pair[0],
      pair[1],
      defined(triangleIndices) ? triangleIndices[triangleStartIndex] : undefined
    );
  }
}

function addHalfEdge(
  halfEdgeMap,
  vertexPositionGetter,
  sourceVertexIdx,
  destinationVertexIdx,
  triangleStartIndex
) {
  var halfEdge = {
    sourceVertex: vertexPositionGetter(sourceVertexIdx),
    destinationVertex: vertexPositionGetter(destinationVertexIdx),
    originalIdx: [sourceVertexIdx],
    destinationIdx: [destinationVertexIdx],
  };
  if (defined(triangleStartIndex)) {
    halfEdge.triangleStartIndex = [triangleStartIndex];
  }
  var mapIdx = generateMapKey(
    halfEdge.sourceVertex,
    halfEdge.destinationVertex
  );
  var halfEdgeFromMap = halfEdgeMap.get(mapIdx);
  if (halfEdgeFromMap) {
    halfEdgeFromMap.originalIdx.push(sourceVertexIdx);
    halfEdgeFromMap.destinationIdx.push(destinationVertexIdx);
    if (defined(triangleStartIndex)) {
      halfEdgeFromMap.triangleStartIndex.push(triangleStartIndex);
    }
  } else {
    halfEdgeMap.set(mapIdx, halfEdge);
  }
  return halfEdge;
}

function generateMapKey(sourceVertex, destinationVertex) {
  return (
    "" +
    sourceVertex[0] +
    sourceVertex[1] +
    sourceVertex[2] +
    "#" +
    destinationVertex[0] +
    destinationVertex[1] +
    destinationVertex[2]
  );
}

function getNeighboringEdge(halfEdgeMap, edge) {
  var neighborIdx = generateMapKey(edge.destinationVertex, edge.sourceVertex);
  return halfEdgeMap.get(neighborIdx);
}

// Returns index of first vertex of triangle
function getFirstVertexOfFaces(halfEdge, triangleIndices) {
  var faces = [];
  if (halfEdge.triangleStartIndex) {
    // Indexed triangle mode
    faces.push(...halfEdge.triangleStartIndex);
  } else {
    for (var j = 0; j < halfEdge.originalIdx.length; j++) {
      // Unindexed triangle mode
      var triangleStart =
        halfEdge.originalIdx[j] - (halfEdge.originalIdx[j] % 3);
      faces.push(triangleStart);
    }
  }
  return faces;
}

/**
 * From a directed half edge map, determines which edges should be outlined.
 * @private
 */
function findEdgesToOutline(
  halfEdgeMap,
  vertexNormalGetter,
  triangleIndices,
  minimumAngle
) {
  var outlineThese = [];
  var checked = new Set();
  var allEdges = Array.from(halfEdgeMap.values());
  var maxIndex = 0;
  for (var edgeIdx = 0; edgeIdx < allEdges.length; edgeIdx++) {
    var edge = allEdges[edgeIdx];
    if (
      checked.has(generateMapKey(edge.sourceVertex, edge.destinationVertex)) ||
      checked.has(generateMapKey(edge.destinationVertex, edge.sourceVertex))
    ) {
      continue;
    }
    var neighbor = getNeighboringEdge(halfEdgeMap, edge);
    if (!defined(neighbor)) {
      continue;
    }
    // For performance reasons we want to cap the number of vertices we check
    // for each edge. Some meshes can have a lot of duplicate vertices in the
    // same spot, so we don't want to outline those many, many times.
    // This number is arbitrary.
    var numIndicesToCheck = 21;
    if (edge.originalIdx.length > numIndicesToCheck) {
      edge.originalIdx = edge.originalIdx.slice(0, numIndicesToCheck);
    }
    if (neighbor.originalIdx.length > numIndicesToCheck) {
      neighbor.originalIdx = neighbor.originalIdx.slice(0, numIndicesToCheck);
    }

    //  Get all the faces that share this edge
    var primaryEdgeFaces = getFirstVertexOfFaces(edge, triangleIndices);
    var neighborEdgeFaces = getFirstVertexOfFaces(neighbor, triangleIndices);
    var outline = false;
    var startVertex;
    var endVertex;
    for (var i = 0; i < primaryEdgeFaces.length; i++) {
      if (outline) {
        break;
      }
      var faceNormal = vertexNormalGetter(primaryEdgeFaces[i]);
      for (var j = 0; j < neighborEdgeFaces.length; j++) {
        if (primaryEdgeFaces[i] === neighborEdgeFaces[j]) {
          continue;
        }
        var neighborNormal = vertexNormalGetter(neighborEdgeFaces[j]);
        if (!defined(faceNormal) || !defined(neighborNormal)) {
          continue;
        }
        var angleBetween;
        try {
          angleBetween = Cartesian3.angleBetween(
            Cartesian3.fromArray(faceNormal),
            Cartesian3.fromArray(neighborNormal)
          );
        } catch (error) {
          console.log(
            "Error trying to find the angle between two faces' normals: " +
              error
          );
          continue;
        }
        if (angleBetween > minimumAngle && angleBetween < Math.PI) {
          // Outline this edge
          startVertex = edge.originalIdx[0];
          endVertex = edge.destinationIdx[0];
          outlineThese.push(startVertex);
          outlineThese.push(endVertex);
          maxIndex = Math.max(maxIndex, startVertex, endVertex);
          outline = true;
          break;
          // We don't need to check any other faces that share this edge,
          // we already know we need to outline it
        }
      }
    }

    checked.add(generateMapKey(edge.sourceVertex, edge.destinationVertex));
    checked.add(
      generateMapKey(neighbor.sourceVertex, neighbor.destinationVertex)
    );
  }

  if (maxIndex > MAX_GLTF_UINT16_INDEX) {
    // The largest index won't fit in a Uint16, so use a Uint32
    return new Uint32Array(outlineThese);
  }
  return new Uint16Array(outlineThese);
}

export default ModelOutlineGenerator;
