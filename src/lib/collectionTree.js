// Tree model for collections.
//
// A collection is: { id, name, variables: [], items: [ node, ... ] }
// A node is either:
//   folder:  { id, type:'folder', name, items: [ node, ... ] }
//   request: { id, type:'request', ...requestFields }
//
// All helpers are pure and return new arrays/objects so React state updates
// stay immutable.

import { newRequest, newCollection, normalizeRequest, uid } from './factory.js';

export function newFolder(name = 'New Folder') {
  return {
    id: uid('fld'),
    type: 'folder',
    name,
    description: '',
    auth: null, // null means "inherit from the parent collection"
    preRequest: '',
    tests: '',
    items: [],
  };
}

// Ensure a collection has the tree shape, migrating the legacy `requests[]`.
export function normalizeCollection(collection) {
  const defaults = newCollection(collection.name || 'Collection');
  const base = {
    id: collection.id || defaults.id,
    name: collection.name || 'Collection',
    description: collection.description || '',
    variables: collection.variables || [],
    auth: collection.auth
      ? { ...defaults.auth, ...collection.auth }
      : defaults.auth,
    preRequest: collection.preRequest || '',
    tests: collection.tests || '',
    items: [],
  };
  if (Array.isArray(collection.items)) {
    base.items = collection.items.map(normalizeNode);
  } else if (Array.isArray(collection.requests)) {
    // Legacy flat shape -> wrap each request as a request node.
    base.items = collection.requests.map((r) => ({
      ...normalizeRequest(r),
      type: 'request',
    }));
  }
  return base;
}

function normalizeNode(node) {
  if (node && node.type === 'folder') {
    return {
      id: node.id || uid('fld'),
      type: 'folder',
      name: node.name || 'Folder',
      description: typeof node.description === 'string' ? node.description : '',
      auth: node.auth || null,
      preRequest: node.preRequest || '',
      tests: node.tests || '',
      items: (node.items || []).map(normalizeNode),
    };
  }
  // treat everything else as a request
  return { ...normalizeRequest(node), type: 'request' };
}

// ---- immutable tree operations keyed by node id ----

// Map over every node, replacing the one with matching id via `fn`.
function mapItems(items, id, fn) {
  return items.map((node) => {
    if (node.id === id) return fn(node);
    if (node.type === 'folder') {
      return { ...node, items: mapItems(node.items, id, fn) };
    }
    return node;
  });
}

// Remove the node with matching id anywhere in the tree.
function removeItem(items, id) {
  const next = [];
  for (const node of items) {
    if (node.id === id) continue;
    if (node.type === 'folder') {
      next.push({ ...node, items: removeItem(node.items, id) });
    } else {
      next.push(node);
    }
  }
  return next;
}

// Insert `child` into the folder with `folderId`; if folderId is null, append
// to the top level.
function insertInto(items, folderId, child) {
  if (folderId == null) return [...items, child];
  return items.map((node) => {
    if (node.id === folderId && node.type === 'folder') {
      return { ...node, items: [...node.items, child] };
    }
    if (node.type === 'folder') {
      return { ...node, items: insertInto(node.items, folderId, child) };
    }
    return node;
  });
}

// Find a node and its parent list by id (returns { node, siblings, index }).
function locate(items, id, siblings = items) {
  for (let i = 0; i < siblings.length; i += 1) {
    const node = siblings[i];
    if (node.id === id) return { node, siblings, index: i };
    if (node.type === 'folder') {
      const found = locate(items, id, node.items);
      if (found) return found;
    }
  }
  return null;
}

// ---- public collection-level editors ----
// Each takes the full collections array and returns a new one.

export function renameNode(collections, collectionId, nodeId, name) {
  return collections.map((c) =>
    c.id === collectionId ? { ...c, items: mapItems(c.items, nodeId, (n) => ({ ...n, name })) } : c
  );
}

export function renameCollection(collections, collectionId, name) {
  return collections.map((c) => (c.id === collectionId ? { ...c, name } : c));
}

export function deleteNode(collections, collectionId, nodeId) {
  return collections.map((c) =>
    c.id === collectionId ? { ...c, items: removeItem(c.items, nodeId) } : c
  );
}

export function addFolder(collections, collectionId, parentFolderId, name) {
  const folder = newFolder(name);
  return collections.map((c) =>
    c.id === collectionId ? { ...c, items: insertInto(c.items, parentFolderId, folder) } : c
  );
}

export function addRequest(collections, collectionId, parentFolderId, request) {
  const node = { ...normalizeRequest(request || newRequest()), type: 'request' };
  return {
    collections: collections.map((c) =>
      c.id === collectionId ? { ...c, items: insertInto(c.items, parentFolderId, node) } : c
    ),
    node,
  };
}

export function updateRequestNode(collections, collectionId, request) {
  return collections.map((c) =>
    c.id === collectionId
      ? {
          ...c,
          items: mapItems(c.items, request.id, () => ({
            ...normalizeRequest(request),
            type: 'request',
          })),
        }
      : c
  );
}

export function duplicateNode(collections, collectionId, nodeId) {
  return collections.map((c) => {
    if (c.id !== collectionId) return c;
    const found = locate(c.items, nodeId);
    if (!found) return c;
    const copy = cloneWithNewIds(found.node);
    copy.name = `${copy.name} copy`;
    const next = [...found.siblings];
    // Insert right after the original within its sibling list.
    const items = insertAfter(c.items, nodeId, copy);
    return { ...c, items };
  });
}

function insertAfter(items, afterId, child) {
  const out = [];
  for (const node of items) {
    if (node.type === 'folder') {
      out.push({ ...node, items: insertAfter(node.items, afterId, child) });
    } else {
      out.push(node);
    }
    if (node.id === afterId) out.push(child);
  }
  return out;
}

function cloneWithNewIds(node) {
  if (node.type === 'folder') {
    return {
      ...node,
      id: uid('fld'),
      items: node.items.map(cloneWithNewIds),
    };
  }
  return { ...node, id: uid('req') };
}

// Reorder a node within its own sibling list by delta (-1 up, +1 down).
export function moveNode(collections, collectionId, nodeId, delta) {
  return collections.map((c) => {
    if (c.id !== collectionId) return c;
    return { ...c, items: reorder(c.items, nodeId, delta) };
  });
}

function reorder(items, nodeId, delta) {
  const idx = items.findIndex((n) => n.id === nodeId);
  if (idx >= 0) {
    const target = idx + delta;
    if (target < 0 || target >= items.length) return items;
    const next = [...items];
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    return next;
  }
  // not at this level -> recurse into folders
  return items.map((n) =>
    n.type === 'folder' ? { ...n, items: reorder(n.items, nodeId, delta) } : n
  );
}

// Detach a node (returns { items, removed }) from an items tree.
function detach(items, nodeId) {
  let removed = null;
  const walk = (list) => {
    const out = [];
    for (const node of list) {
      if (node.id === nodeId) {
        removed = node;
        continue;
      }
      if (node.type === 'folder') {
        out.push({ ...node, items: walk(node.items) });
      } else {
        out.push(node);
      }
    }
    return out;
  };
  const items2 = walk(items);
  return { items: items2, removed };
}

// True if `ancestorId` folder contains `nodeId` somewhere below it.
function isDescendant(items, ancestorId, nodeId) {
  const findFolder = (list) => {
    for (const n of list) {
      if (n.type === 'folder') {
        if (n.id === ancestorId) return n;
        const deeper = findFolder(n.items);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  const folder = findFolder(items);
  if (!folder) return false;
  const contains = (list) =>
    list.some((n) => n.id === nodeId || (n.type === 'folder' && contains(n.items)));
  return contains(folder.items);
}

// Move a node (request or folder) into a target collection + folder.
// targetFolderId null means the collection root. Prevents dropping a folder
// into itself or its own descendant.
export function moveNodeTo(collections, nodeId, targetCollectionId, targetFolderId) {
  // Find source collection.
  const source = findNodeCollection(collections, nodeId);
  if (!source) return collections;

  // Guard: a folder cannot be moved into itself or a descendant.
  if (nodeId === targetFolderId) return collections;
  if (source.id === targetCollectionId && targetFolderId) {
    if (isDescendant(source.items, nodeId, targetFolderId)) return collections;
  }

  // Detach from source.
  const { items: sourceItems, removed } = detach(source.items, nodeId);
  if (!removed) return collections;

  // Insert into target.
  const insert = (items) => {
    if (targetFolderId == null) return [...items, removed];
    return items.map((n) => {
      if (n.id === targetFolderId && n.type === 'folder') {
        return { ...n, items: [...n.items, removed] };
      }
      if (n.type === 'folder') return { ...n, items: insert(n.items) };
      return n;
    });
  };

  return collections.map((c) => {
    if (c.id === source.id && c.id === targetCollectionId) {
      // Same collection: detach then insert on the already-detached items.
      return { ...c, items: insert(sourceItems) };
    }
    if (c.id === source.id) return { ...c, items: sourceItems };
    if (c.id === targetCollectionId) return { ...c, items: insert(c.items) };
    return c;
  });
}

// Reorder/move a node so it sits immediately before `targetNodeId`, anywhere
// in the tree (same or different folder/collection). This is what drag-drop
// onto another request row does. Guards against dropping a folder before one
// of its own descendants.
export function moveNodeBefore(collections, nodeId, targetNodeId) {
  if (nodeId === targetNodeId) return collections;

  const source = findNodeCollection(collections, nodeId);
  const targetCol = findNodeCollection(collections, targetNodeId);
  if (!source || !targetCol) return collections;

  // Guard: can't move a folder into its own descendant chain.
  if (isDescendant(source.items, nodeId, targetNodeId)) return collections;

  // Detach the dragged node from its source collection.
  let removed = null;
  const detachedByCol = {};
  for (const c of collections) {
    if (c.id === source.id) {
      const res = detach(c.items, nodeId);
      removed = res.removed;
      detachedByCol[c.id] = res.items;
    }
  }
  if (!removed) return collections;

  // Insert `removed` right before targetNodeId within whichever items list
  // contains it.
  const insertBefore = (items) => {
    const out = [];
    for (const node of items) {
      if (node.id === targetNodeId) out.push(removed);
      if (node.type === 'folder') {
        out.push({ ...node, items: insertBefore(node.items) });
      } else {
        out.push(node);
      }
    }
    return out;
  };

  return collections.map((c) => {
    // Use the detached list for the source collection, original otherwise.
    const baseItems = c.id === source.id ? detachedByCol[c.id] : c.items;
    if (c.id === targetCol.id) {
      return { ...c, items: insertBefore(baseItems) };
    }
    if (c.id === source.id) {
      return { ...c, items: baseItems };
    }
    return c;
  });
}

// Find the collection that contains any node (folder or request) by id.
export function findNodeCollection(collections, nodeId) {
  const contains = (items) =>
    items.some((n) => n.id === nodeId || (n.type === 'folder' && contains(n.items)));
  return collections.find((c) => contains(c.items || [])) || null;
}

// Return the collection that contains a request with the given id, or null.
export function findRequestCollection(collections, requestId) {
  const contains = (items) =>
    items.some((n) =>
      n.type === 'folder' ? contains(n.items) : n.id === requestId
    );
  return collections.find((c) => contains(c.items || [])) || null;
}

// Flatten a collection (or a folder node) into an ordered list of request
// nodes, depth-first in display order. Used by the Collection Runner.
export function flattenRequests(container) {
  const out = [];
  const walk = (items) => {
    for (const node of items) {
      if (node.type === 'folder') walk(node.items);
      else out.push(node);
    }
  };
  walk(container.items || []);
  return out;
}

// Find a folder node by id within a collection.
export function findFolder(collection, folderId) {
  const walk = (items) => {
    for (const node of items) {
      if (node.type === 'folder') {
        if (node.id === folderId) return node;
        const found = walk(node.items);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(collection.items || []);
}

// List all folders (id + name + depth) for "save into folder" pickers.
export function listFolders(collection) {
  const out = [{ id: null, name: collection.name, depth: 0 }];
  const walk = (items, depth) => {
    for (const node of items) {
      if (node.type === 'folder') {
        out.push({ id: node.id, name: node.name, depth });
        walk(node.items, depth + 1);
      }
    }
  };
  walk(collection.items, 1);
  return out;
}
