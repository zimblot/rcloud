var editor = function () {
    // major key is adsort_order and minor key is name (label)
    var ordering = {
        HEADER: 0, // at top (unused)
        NOTEBOOK: 1,
        MYFOLDER: 2,
        SUBFOLDER: 4
    };
    var CONFIG_VERSION = 1;

    /* "Model-Model-View-Controller"
     .. or something ..
     there are two models: the local state and the global rcs+github
     the local model is private data of this class

     E.g. an interest ("star") is reflected in 7 places:
     Global model
     - the star in rcs (logically in github but they don't have the necessary APIs)
     - the count in rcs
     Local model
     - the entry in notebook_info_[]
     - the bit in my_stars_[]
     View
     - the existence of the node under Notebooks I Starred in the notebook tree UI
     - the filling of the star icon next to the node under All Notebooks in the tree UI
     - the filling of the star icon in the navbar (if current notebook)
     */

    // local model (all caches of stuff stored in RCS/github)
    var username_ = null, // cache of rcloud.username() so we're not reading a cookie
        histories_ = {}, // cached notebook histories
        notebook_info_ = {}, // all notebooks we are aware of
        num_stars_ = {}, // number of stars for all known notebooks
        my_stars_ = {}, // set of notebooks starred by me
        my_friends_ = {}, // people whose notebooks i've starred
        featured_ = [], // featured users - samples, intros, etc
        invalid_notebooks_ = {},
        current_ = null; // current notebook and version

    // view
    var $tree_ = null,
        star_notebook_button_ = null;

    // configuration stuff
    var gist_sources_ = null, // valid gist sources on server
        show_terse_dates_ = false, // show terse date option for the user
        new_notebook_prefix_ = "Notebook ";

    // work around oddities of rserve.js
    function each_r_list(list, f) {
        for(var key in list)
            if(key!=='r_attributes' && key!=='r_type')
                f(key);
    }
    function r_vector(value) {
        return _.isArray(value) ? value : [value];
    }

    //  Model functions
    function someone_elses(name) {
        return name + "'s Notebooks";
    }

    function get_notebook_info(gistname) {
        return notebook_info_[gistname] || {};
    }

    function add_interest(user, gistname) {
        if(!my_stars_[gistname]) {
            my_stars_[gistname] = true;
            my_friends_[user] = (my_friends_[user] || 0) + 1;
        }
    }

    function remove_interest(user, gistname) {
        if(my_stars_[gistname]) {
            delete my_stars_[gistname];
            if(--my_friends_[user] === 0)
                delete my_friends_[user];
        }
    }

    function set_visibility(gistname, visible) {
        var entry = get_notebook_info(gistname);
        entry.visible = visible;
        notebook_info_[gistname] = entry;
        return rcloud.set_notebook_visibility(gistname, visible);
    }

    function add_notebook_info(user, gistname, entry) {
        if(!notebook_info_[gistname])
            notebook_info_[gistname] = {};
        _.extend(notebook_info_[gistname], entry);
        var p = rcloud.set_notebook_info(gistname, entry);
        if(user === username_)
            p = p.then(function() { rcloud.config.add_notebook(gistname); });
        return p;
    }

    function remove_notebook_info(user, gistname) {
        return user === username_ ?
            rcloud.config.remove_notebook(gistname) :
            Promise.resolve();
    }

    function update_notebook_model(user, gistname, description, time) {
        var entry = get_notebook_info(gistname);

        entry.username = user;
        entry.description = description;
        entry.last_commit = time;

        add_notebook_info(user, gistname, entry);
        return entry; // note: let go of promise
    }


    // View (tree) functions

    function node_id(root, username, gistname, version) {
        var ret = '';
        for(var i=0; i < arguments.length; ++i)
            ret = ret + '/' + arguments[i];
        return ret;
    }

    var trnexp = /(\d+)$/;
    function split_number(name) {
        var res = trnexp.exec(name);
        if(!res)
            return null;
        return [name.slice(0, res.index), res[1]];
    }

    function compare_nodes(a, b) {
        var so = a.sort_order-b.sort_order;
        if(so) return so;
        else {
            var alab = a.name || a.label, blab = b.name || b.label;
            // cut trailing numbers and sort separately
            var amatch = split_number(alab), bmatch = split_number(blab);
            if(amatch && bmatch && amatch[0] == bmatch[0]) {
                var an = +amatch[1], bn = +bmatch[1];
                return an - bn;
            }
            var lc = alab.localeCompare(blab);
            if(lc === 0) {
                // put a folder with the same name as a notebook first
                if(a.children) {
                    if(b.children)
                        throw new Error("uh oh, parallel folders");
                    return -1;
                }
                else if(b.children)
                    return 1;
                // make sort stable on gist id (creation time would be better)
                lc = a.gistname.localeCompare(b.gistname);
            }
            return lc;
        }
    }

    // way too subtle. shamelessly copying OSX Finder behavior here (because they're right).
    function find_next_copy_name(username, description) {
        var pid = node_id("alls", username);
        if(description.indexOf('/')!==-1)
            pid += '/' + description.replace(/\/[^\/]*$/,'');
        var parent = $tree_.tree('getNodeById', pid);
        if(parent === undefined)
            return description;
        if(parent.delay_children)
            load_children(parent);
        var map = _.object(_.map(parent.children, function(c) { return [c.full_name, true]; }));
        if(!map[description])
            return description;
        var match, base, n;
        if((match = split_number(description))) {
            base = match[0];
            n = +match[1];
        }
        else {
            base = description;
            n = 1;
        }
        var copy_name;
        do
            copy_name = base + (++n);
        while(map[copy_name]);
        return copy_name;
    }


    function as_folder_hierarchy(nodes, prefix, name_prefix) {
        function is_in_folder(v) { return v.label.match(/([^/]+)\/(.+)/); }
        var in_folders = nodes;
        // tired of seeing the "method 'match' of undefined" error
        if(_.some(in_folders, function(entry) {
            return entry.label === undefined || entry.label === null;
        }))
           throw new Error("incomplete notebook entry (has it been shown yet?)");
        in_folders = _.filter(in_folders, is_in_folder);
        in_folders = _.map(in_folders, function(v) {
            var m = v.label.match(/([^/]+)\/(.+)/);
            var r = _.clone(v);
            r.folder_name = m[1];
            r.label = m[2];
            return r;
        });
        in_folders = _.groupBy(in_folders, function(v) {
            return v.folder_name;
        });
        in_folders = _.map(in_folders, function(v, k) {
            var children = _.map(v, function(o) {
                return _.omit(o, "folder_name");
            });
            var id = prefix + '/' + k,
                full_name = (name_prefix ? name_prefix + '/' : '')  + k;
            return {
                label: k,
                full_name: full_name,
                user: v[0].user,
                sort_order: ordering.NOTEBOOK,
                id: id,
                children: as_folder_hierarchy(children, id, full_name)
            };
        });
        var outside_folders = _.filter(nodes, function(v) {
            return !is_in_folder(v);
        });
        outside_folders.forEach(function(v) {
            v.full_name = (name_prefix ? name_prefix + '/' : '')  + v.label;
        });
        return outside_folders.concat(in_folders).sort(compare_nodes);
    }

    function convert_notebook_set(root, username, set) {
        var notebook_nodes = [];
        for(var name in set) {
            var attrs = set[name];
            var result = {
                label: attrs.description,
                gistname: name,
                user: username,
                root: root,
                visible: attrs.visible,
                source: attrs.source,
                last_commit: attrs.last_commit ? new Date(attrs.last_commit) : 'none',
                id: node_id(root, username, name),
                sort_order: ordering.NOTEBOOK,
                fork_desc:attrs.fork_desc
            };
            notebook_nodes.push(result);
        }
        return notebook_nodes;
    }

    function populate_interests(my_stars_array) {
        function create_user_book_entry_map(books) {
            var users = {};
            _.each(books,
                   function(book){
                       var entry = notebook_info_[book];
                       if(!entry) {
                           invalid_notebooks_[book] = null;
                           return users;
                       }
                       if(!entry.username || entry.username === "undefined" ||
                          !entry.description || !entry.last_commit) {
                           invalid_notebooks_[book] = entry;
                           return users;
                       }
                       var user = users[entry.username] = users[entry.username] || {};
                       user[book] = entry;
                       return users;
                   });
            return users;
        }

        var interests = create_user_book_entry_map(my_stars_array);
        var user_nodes = [];
        for (var username in interests) {
            var user_notebooks = interests[username];
            for(var gistname in user_notebooks) {
                add_interest(username, gistname);
                // sanitize... this shouldn't really happen...
                if(!user_notebooks[gistname].description)
                    user_notebooks[gistname].description = "(no description)";
            }

            var notebook_nodes = convert_notebook_set('interests', username, user_notebooks);
            var id = node_id('interests', username);
            var mine = username === username_;
            var node = {
                label: mine ? "My Notebooks" : someone_elses(username),
                id: id,
                sort_order: mine ? ordering.MYFOLDER : ordering.SUBFOLDER,
                children: as_folder_hierarchy(notebook_nodes, id).sort(compare_nodes)
            };
            user_nodes.push(node);
        }
        return {
            label: 'Notebooks I Starred',
            id: '/interests',
            children: user_nodes.sort(compare_nodes)
        };
    }

    function populate_all_notebooks(user_notebooks) {
        function create_book_entry_map(books) {
            return _.chain(books)
                .filter(function(book) {
                    var entry = notebook_info_[book];
                    if(!entry) {
                        invalid_notebooks_[book] = null;
                        return false;
                    }
                    if(!entry.username || entry.username === "undefined" ||
                       !entry.description || !entry.last_commit) {
                        invalid_notebooks_[book] = entry;
                        return false;
                    }
                    return true;
                })
                .map(function(book) {
                    var entry = notebook_info_[book];
                    return [book, entry];
                })
                .object().value();
        }

        var user_nodes = [], my_config = null;
        each_r_list(user_notebooks, function(username) {
            var notebook_nodes =
                    convert_notebook_set('alls', username,
                                         create_book_entry_map(r_vector(user_notebooks[username])));
            var mine = username===username_;
            var id = node_id('alls', username);
            var node = {
                label: mine ? "My Notebooks" : someone_elses(username),
                id: id,
                sort_order: mine ? ordering.MYFOLDER : ordering.SUBFOLDER,
                children: as_folder_hierarchy(notebook_nodes, id).sort(compare_nodes)
            };
            user_nodes.push(node);
        });
        return {
            label: 'All Notebooks',
            id: '/alls',
            children: user_nodes.sort(compare_nodes)
        };
    }

    function duplicate_tree_data(tree, f) {
        var t2 = f(tree);
        if(tree.children) {
            var ch2 = [];
            for(var i=0; i<tree.children.length; ++i)
                ch2.push(duplicate_tree_data(tree.children[i], f));
            t2.children = ch2;
        }
        return t2;
    }

    function transpose_notebook(destroot) {
        return function(datum) {
            if(datum.delay_children)
                load_children(datum);
            var d2 = _.pick(datum, "label", "name", "full_name", "gistname", "user", "visible", "source", "last_commit", "sort_order");
            d2.id = datum.id.replace("/alls/", '/'+destroot+'/');
            d2.root = destroot;
            return d2;
        };
    }

    function create_notebook_root(src_trees, root, title) {
        var reroot = transpose_notebook(root);
        var subtrees = src_trees.map(function(subtree) {
            return duplicate_tree_data(subtree, reroot);
        });
        return {
            label: title,
            id: '/'+root,
            children: subtrees
        };
    }

    function alls_name(subtree) {
        return subtree.id.replace("/alls/","");
    }

    function populate_friends(alls_root) {
        var friend_subtrees = alls_root.children.filter(function(subtree) {
            return my_friends_[alls_name(subtree)]>0;
        });
        return create_notebook_root(friend_subtrees, 'friends', 'People I Starred');
    }

    function populate_featured(alls_root) {
        var featured_subtrees = alls_root.children.filter(function(subtree) {
            return featured_.indexOf(alls_name(subtree))>=0;
        });
        featured_ = featured_subtrees.map(alls_name); // remove any we didn't find in All Notebooks
        if(!featured_subtrees.length)
            return null;
        return create_notebook_root(featured_subtrees, 'featured', 'RCloud Sample Notebooks');
    }

    function load_tree(root_data) {
        // delay construction of dom elements for Alls
        var alls = _.find(root_data, function(root) { return root.id === "/alls"; }).children;
        for(var i = 0; i < alls.length; ++i)
            if(alls[i].children && alls[i].children.length) {
                alls[i].delay_children = alls[i].children;
                alls[i].children = [{label: 'loading...'}];
            }
        result.create_book_tree_widget(root_data);
        var interests = $tree_.tree('getNodeById', "/interests");
        $tree_.tree('openNode', interests);
    }

    function load_children(n) {
        $tree_.tree('loadData', n.delay_children, n);
        delete n.delay_children;
    }

    function load_everything() {
        return Promise.all([
            rcloud.get_users()
            .then(function(allUsers){
                //save them to global here
                editor.allTheUsers = allUsers;
                return allUsers
            })
            .then(rcloud.config.all_notebooks_multiple_users),
            rcloud.stars.get_my_starred_notebooks(),
            rcloud.get_gist_sources()
        ])
            .spread(function(user_notebook_set, my_stars_array, gist_sources) {
                my_stars_array = r_vector(my_stars_array);
                gist_sources_ = gist_sources;
                var all_notebooks = [];
                each_r_list(user_notebook_set, function(username) {
                    all_notebooks = all_notebooks.concat(r_vector(user_notebook_set[username]));
                });
                all_notebooks = all_notebooks.concat(my_stars_array);
                all_notebooks = _.uniq(all_notebooks.sort(), true);
                var root_data = [];
                return Promise.all([rcloud.config.get_current_notebook(),
                                    rcloud.stars.get_multiple_notebook_star_counts(all_notebooks),
                                    rcloud.get_multiple_notebook_infos(all_notebooks),
                                    rcloud.config.get_alluser_option('featured_users')])
                    .spread(function(current, counts, notebook_entries, featured) {
                        current_ = current;
                        num_stars_ = counts;
                        notebook_info_ = notebook_entries;
                        featured_ = featured || [];
                        if(_.isString(featured_))
                            featured_ = [featured_];
                    })
                    .then(function() {
                        var alls_root = populate_all_notebooks(user_notebook_set);
                        return [
                            populate_featured(alls_root),
                            populate_interests(my_stars_array),
                            populate_friends(alls_root),
                            alls_root
                        ].filter(function(t) { return !!t; });
                    });
            })
            .then(load_tree)
            .then(function() {
                for(var book in invalid_notebooks_) {
                    var entry = invalid_notebooks_[book];
                    if(!entry)
                        console.log("notebook metadata for " + book + " is missing.");
                    else
                        console.log("notebook metadata for " + book + " has invalid entries: " + JSON.stringify(_.pick(entry, "username","description","last_commit","visible","source")));
                }
            })
            .catch(rclient.post_rejection);
    }

    function find_sort_point(data, parent) {
        // this could be a binary search but linear is probably fast enough
        // for a single insert, and it also could be out of order
        for(var i = 0; i < parent.children.length; ++i) {
            var child = parent.children[i];
            var so = compare_nodes(data, child);
            if(so<0)
                return child;
        }
        return 0;
    }
    function insert_alpha(data, parent) {
        var before = find_sort_point(data, parent);
        if(before)
            return $tree_.tree('addNodeBefore', data, before);
        else
            return $tree_.tree('appendNode', data, parent);
    }

    function remove_empty_parents(dp) {
        // remove any empty notebook hierarchy
        while(dp.children.length===0 && dp.sort_order===ordering.NOTEBOOK) {
            var dp2 = dp.parent;
            $tree_.tree('removeNode', dp);
            dp = dp2;
        }
    }

    function update_tree(root, user, gistname, path, last_chance, create) {
        if(!root)
            throw new Error("need root");
        if(!user)
            throw new Error("need user");
        if(!gistname)
            throw new Error("need gistname");
        // make sure parents exist
        var parid = node_id(root, user),
            parent = $tree_.tree('getNodeById', parid),
            pdat = null,
            node = null;
        if(!parent) {
            var mine = user === username_; // yes it is possible I'm not my own friend
            parent = $tree_.tree('getNodeById', node_id(root));
            if(!parent) {
                throw new Error("root '" + root + "' of notebook tree not found!");
            }
            pdat = {
                label: mine ? "My Notebooks" : someone_elses(user),
                id: node_id(root, user),
                sort_order: mine ? ordering.MYFOLDER : ordering.SUBFOLDER
            };
            parent = insert_alpha(pdat, parent);
        }
        if(parent.delay_children)
            load_children(parent);
        while('children' in path) {
            node = $tree_.tree('getNodeById', path.id);
            if(!node) {
                pdat = _.omit(path, 'children');
                node = insert_alpha(pdat, parent);
            }
            parent = node;
            path = path.children[0];
        }
        var data = path;
        var id = node_id(root, user, gistname);
        node = $tree_.tree('getNodeById', id);
        if(!node && !create)
            return null;
        var children;
        data.gistname = gistname;
        data.id = id;
        data.root = root;
        data.user = user;
        if(node) {
            children = node.children;
            if(last_chance)
                last_chance(node); // hacky
            var dp = node.parent;
            if(dp===parent && node.name===data.label)
                $tree_.tree('updateNode', node, data);
            else {
                $tree_.tree('removeNode', node);
                node = insert_alpha(data, parent);
                remove_empty_parents(dp);
            }
        }
        else
            node = insert_alpha(data, parent);
        return node;
    }

    function find_index(collection, filter) {
        for (var i = 0; i < collection.length; i++) {
            if(filter(collection[i], i, collection))
                return i;
        }
        return -1;
    }


    // add_history_nodes
    // whither is 'hide' - erase all, 'index' - show thru index, 'sha' - show thru sha, 'more' - show INCR more
    function update_history_nodes(node, whither, where) {
        var INCR = 5;
        var debug_colors = false;
        var ellipsis = null;
        if(node.children.length && node.children[node.children.length-1].id == 'showmore')
            ellipsis = node.children[node.children.length-1];
        function curr_count() {
            var n = node.children.length;
            return ellipsis ? n-1 : n;
        }
        function show_sha(history, sha) {
            var sha_ind = find_index(history, function(hist) { return hist.version===sha; });
            if(sha_ind<0)
                throw new Error("didn't find sha " + where + " in history");
            return sha_ind + INCR - 1; // show this many including curr (?)
        }

        function process_history(nshow) {
            function do_color(dat, color) {
                if(debug_colors)
                    dat.color = color;
            }

            function get_date_diff(d1,d2) {
                var now = new Date();
                d1 = new Date(d1);
                d2 = new Date(d2);
                var diff = d1 - d2;
                var min_same = d1.getMinutes() === d2.getMinutes();
                var hour_same = d1.getHours() === d2.getHours();
                var isDateSame = d1.toLocaleDateString() === d2.toLocaleDateString();
                if(diff <= 60*1000 && hour_same && min_same && show_terse_dates_)
                    return null;
                else
                    return format_date_time_stamp(d1, diff, isDateSame, true);
            }

            function display_date_for_entry(i) {
                var hist = history[i];
                var d;
                if(i+1 < history.length) {
                    d = get_date_diff(hist.committed_at, history[i + 1].committed_at);
                }
                else
                    d = new Date(hist.committed_at);
                return d || 'none';
            }
            function make_hist_node(color, i, force_date) {
                var hist = history[i];
                var hdat = _.clone(node);
                var sha = hist.version.substring(0, 10);
                var d;
                hdat.committed_at = new Date(hist.committed_at);
                hdat.last_commit = force_date ? hdat.committed_at : display_date_for_entry(i);
                hdat.label = (hist.tag?hist.tag:sha);
                hdat.version = hist.version;
                hdat.id = node.id + '/' + hdat.version;
                do_color(hdat, color);
                return hdat;
            }
            function update_hist_node(node, i) {
                var hist = history[i];
                var sha = hist.version.substring(0, 10);
                var attrs = {
                    label: (hist.tag?hist.tag:sha)
                };
                $tree_.tree('updateNode', node, attrs);
            }
            var history = histories_[node.gistname].slice(1); // first item is current version
            if(!history)
                return;
            var children = [];
            nshow = Math.min(nshow, history.length);

            if(debug_colors)
                for(var ii = 0, ee = curr_count(); ii<ee; ++ii)
                    $tree_.tree('updateNode', node.children[ii], {color: ''});

            // remove forced date on version above ellipsis, if any
            if(ellipsis) {
                $tree_.tree('updateNode',
                            node.children[node.children.length-2],
                            {
                                last_commit: display_date_for_entry(node.children.length-2)
                            });
            }

            // insert at top
            var nins, insf = null, starting = node.children.length===0;
            if(!starting) {
                var first = node.children[0];
                nins = find_index(history, function(h) { return h.version==first.version; });
                insf = function(dat) { return $tree_.tree('addNodeBefore', dat, first); };
            }
            else {
                nins = nshow;
                insf = function(dat) { return $tree_.tree('appendNode', dat, node); };
            }
            for(var i=0; i<nins; ++i)
                insf(make_hist_node('green', i, starting && i==nins-1));

            var count = curr_count();
            // updates
            for(i = nins; i<count; ++i)
                update_hist_node(node.children[i], i);

            // add or trim bottom
            if(count < nshow) { // top up
                if(ellipsis)
                    insf = function(dat) { return $tree_.tree('addNodeBefore', dat, ellipsis); };
                else
                    insf = function(dat) { return $tree_.tree('appendNode', dat, node); };
                for(i=count; i<nshow; ++i)
                    insf(make_hist_node('mediumpurple', i, i==nshow-1));
            }
            else if(count > nshow) // trim any excess
                for(i=count-1; i>=nshow; --i)
                    $tree_.tree('removeNode', node.children[i]);


            // hide or show ellipsis
            if(ellipsis) {
                if(nshow === history.length) {
                    $tree_.tree('removeNode', ellipsis);
                    ellipsis = null;
                }
            }
            else {
                if(nshow < history.length) {
                    var data = {
                        label: '...',
                        id: 'showmore'
                    };
                    ellipsis = $tree_.tree('appendNode', data, node);
                }
            }
        }
        var nshow;
        if(whither==='hide') {
            for(var i = node.children.length-1; i >= 0; --i)
                $tree_.tree('removeNode', node.children[i]);
            return Promise.resolve(node);
        }
        else if(whither==='index')
            nshow = Math.max(where, INCR);
        else if(whither==='same')
            nshow = curr_count();
        else if(whither==='more')
            nshow = curr_count() + INCR;
        else if(whither==='sha') {
            if(histories_[node.gistname])
                nshow = show_sha(histories_[node.gistname], where);
        }
        else throw new Error("update_history_nodes don't understand how to seek '" + whither + "'");

        if(histories_[node.gistname]) {
            process_history(nshow);
            return Promise.resolve(node);
        }
        else
            return rcloud.load_notebook(node.gistname, null).then(function(notebook) {
                histories_[node.gistname] = notebook.history;
                if(whither==='sha')
                    nshow = show_sha(histories_[node.gistname], where);
                process_history(nshow);
                return node;
        });
    }

    function scroll_into_view(node) {
        var p = node.parent;
        while(p.sort_order===ordering.NOTEBOOK) {
            $tree_.tree('openNode', p);
            p = p.parent;
        }
        ui_utils.scroll_into_view($tree_.parent(), 50, 100, $(node.element));
    }

    function select_node(node) {
        $tree_.tree('selectNode', node);
        scroll_into_view(node);
        if(node.user === username_)
            RCloud.UI.notebook_title.make_editable(node, node.element, true);
        else
            RCloud.UI.notebook_title.make_editable(null);
    }

    function update_tree_entry(root, user, gistname, entry, create) {
        var data = {user: user,
                    label: entry.description,
                    last_commit: new Date(entry.last_commit),
                    sort_order: ordering.NOTEBOOK,
                    source: entry.source,
                    visible: entry.visible};

        // always show the same number of history nodes as before
        var whither = 'hide', where = null;
        var inter_path = as_folder_hierarchy([data], node_id(root, user))[0];
        var node = update_tree(root, user, gistname, inter_path,
                               function(node) {
                                   if(node.children.length) {
                                       whither = 'index';
                                       where = node.children.length;
                                       if(node.children[where-1].id==='showmore')
                                           --where;
                                   }
                               }, create);
        if(!node)
            return Promise.resolve(null); // !create

        // if we're looking at an old version, make sure it's shown
        if(gistname===current_.notebook && current_.version) {
            whither = 'sha';
            where = current_.version;
        }
        return update_history_nodes(node, whither, where);
    }

    function update_url(opts) {
        var url = ui_utils.make_url('edit.html', opts);
        window.history.replaceState("rcloud.notebook", null, url);
        return rcloud.api.set_url(url);
    }

    function update_notebook_view(user, gistname, entry, selroot) {
        function open_and_select(node) {
            if(current_.version) {
                $tree_.tree('openNode', node);
                var n2 = $tree_.tree('getNodeById',
                                     node_id(node.root, user, gistname, current_.version));
                if(!n2)
                    throw new Error('tree node was not created for current history');
                node = n2;
            }
            select_node(node);
        }
        var p, i_starred = result.i_starred(gistname);
        if(selroot === true)
            selroot = featured_.indexOf(user) >=0 ? 'featured' :
                i_starred ? 'interests' :
                my_friends_[user] ? 'friends': 'alls';
        if(i_starred) {
            p = update_tree_entry('interests', user, gistname, entry, true);
            if(selroot==='interests')
                p.then(open_and_select);
        }
        if(gistname === current_.notebook) {
            if(!_.isUndefined(star_notebook_button_) && !_.isNull(star_notebook_button_))
                star_notebook_button_.set_state(i_starred);
            $('#curr-star-count').text(result.num_stars(gistname));
        }
        if(my_friends_[user]) {
            p = update_tree_entry('friends', user, gistname, entry, true);
            if(selroot==='friends')
                p.then(open_and_select);
        }
        if(featured_.indexOf(user)>=0) {
            p = update_tree_entry('featured', user, gistname, entry, true);
            if(selroot==='featured')
                p.then(open_and_select);
        }

        p = update_tree_entry('alls', user, gistname, entry, true);
        if(selroot==='alls')
            p.then(open_and_select);
    }

    function remove_node(node) {
        var parent = node.parent;
        ui_utils.fake_hover(node);
        $tree_.tree('removeNode', node);
        remove_empty_parents(parent);
        if(node.root === 'interests' && node.user !== username_ && parent.children.length === 0)
            $tree_.tree('removeNode', parent);
    }

    function remove_notebook_view(user, gistname) {
        function do_remove(id) {
            var node = $tree_.tree('getNodeById', id);
            if(node)
                remove_node(node);
            else
                console.log("tried to remove node that doesn't exist: " + id);
        }
        if(my_friends_[user])
            do_remove(node_id('friends', user, gistname));
        do_remove(node_id('alls', user, gistname));
    }

    function unstar_notebook_view(user, gistname, selroot) {
        var inter_id = node_id('interests', user, gistname);
        var node = $tree_.tree('getNodeById', inter_id);
        if(!node) {
            console.log("attempt to unstar notebook we didn't know was starred", inter_id);
            return;
        }
        remove_node(node);
        update_notebook_view(user, gistname, get_notebook_info(gistname), selroot);
    }

    function update_notebook_from_gist(result, history, selroot) {
        var user = result.user.login, gistname = result.id;
        // we only receive history here if we're at HEAD, so use that if we get
        // it.  otherwise use the remembered history if any.  otherwise
        // update_history_nodes will do an async call to get the history.
        if(history)
            histories_[gistname] = history;

        var entry = update_notebook_model(user, gistname,
                                          result.description,
                                          result.updated_at || result.history[0].committed_at);

        update_notebook_view(user, gistname, entry, selroot);
    }

    function change_folder_friendness(user) {
        if(my_friends_[user]) {
            var anode = $tree_.tree('getNodeById', node_id('alls', user));
            var ftree;
            if(anode)
                ftree = duplicate_tree_data(anode, transpose_notebook('friends'));
            else { // this is a first-time load case
                var mine = user === username_;
                ftree = {
                    label: mine ? "My Notebooks" : someone_elses(user),
                    id: node_id('friends', user),
                    sort_order: mine ? ordering.MYFOLDER : ordering.SUBFOLDER
                };
            }
            var parent = $tree_.tree('getNodeById', node_id('friends'));
            var node = insert_alpha(ftree, parent);
            $tree_.tree('loadData', ftree.children, node);
        }
        else {
            var n2 = $tree_.tree('getNodeById', node_id('friends', user));
            $tree_.tree('removeNode', n2);
        }
    }

    function format_date_time_stamp(date, diff, isDateSame, for_version) {
        function pad(n) { return n<10 ? '0'+n : n; }
        var now = new Date();
        var time_part = '<span class="notebook-time">' + date.getHours() + ':' + pad(date.getMinutes()) + '</span>';
        var date_part = (date.getMonth()+1) + '/' + date.getDate();
        var year_part = date.getFullYear().toString().substr(2,2);
        if(diff < 24*60*60*1000 && isDateSame && show_terse_dates_ && for_version)
            return time_part;
        else if(date.getFullYear() === now.getFullYear())
            return '<span>' + date_part + ' ' + time_part + '</span>';
        else
            return '<span>' + date_part + '/' + year_part + ' ' + time_part + '</span>';
    }

    function display_date_html(ds) {
        if(ds==='none')
            return '';
        if(typeof ds==='string')
            return ds;
        var date = new Date(ds);
        var now = new Date();
        var diff = now - date;
        return format_date_time_stamp(date, diff, true, false);
    }

    function display_date(ds) {
        // return an element
        return $(display_date_html(ds))[0];
    }

    function on_create_tree_li(node, $li) {
        $li.css("min-height","15px");
        var element = $li.find('.jqtree-element'),
            title = element.find('.jqtree-title');
        title.css('color', node.color);
        if(node.gistname) {
            if(node.source)
                title.addClass('foreign');
            else if(!node.visible)
                title.addClass('private');
        }
        if(node.version || node.id === 'showmore')
            title.addClass('history');
        var date;
        if(node.last_commit) {
            date = $.el.span({'class': 'notebook-date'},
                                   display_date(node.last_commit));
        }
        var right = $.el.span({'class': 'notebook-right'}, date);
        // if it was editable before, we need to restore that - either selected or open folder tree node
        if(node.user === username_ && ($tree_.tree('isNodeSelected', node) ||
                                       !node.gistname && node.full_name && node.is_open))
            RCloud.UI.notebook_title.make_editable(node, $li, true);
        RCloud.UI.notebook_commands.decorate($li, node, right);
        element.append(right);
    }

    function tree_click(event) {
        if(event.node.id === 'showmore')
            result.show_history(event.node.parent, false);
        else if(event.node.gistname) {
            if(event.click_event.metaKey || event.click_event.ctrlKey)
                result.open_notebook(event.node.gistname, event.node.version, true, true);
            else {
                // it's weird that a notebook exists in two trees but only one is selected (#220)
                // just select - and this enables editability
                if(event.node.gistname === current_.notebook &&
                    event.node.version == current_.version && event.node.version == null) // deliberately null-vague here
                    select_node(event.node);
                else
                    result.open_notebook(event.node.gistname, event.node.version || null, event.node.root, false);
            }
        }
        else {
            if(!event.node.is_open) {
                $tree_.tree('openNode', event.node);
                ui_utils.fake_hover(event.node);
            }
        }
        return false;
    }
    function tree_open(event) {
        var n = event.node;
        if(n.delay_children)
            load_children(n);
        if(event.node.full_name && event.node.user === username_)
            RCloud.UI.notebook_title.make_editable(event.node, event.node.element, true);
        $('#collapse-notebook-tree').trigger('size-changed');
    }
    function tree_close(event) {
        if(event.node.full_name)
            RCloud.UI.notebook_title.make_editable(event.node, event.node.element, false);
    }
    var NOTEBOOK_LOAD_FAILS = 5;
    function open_last_loadable() {
        var tries_left = NOTEBOOK_LOAD_FAILS;
        RCloud.UI.session_pane.allow_clear = false;
        return rcloud.config.get_recent_notebooks()
            .then(function(recent) {
                var sorted = _.chain(recent)
                        .pairs()
                        .filter(function(kv) { return kv[0] != 'r_attributes' && kv[0] != 'r_type'; })
                        .map(function(kv) { return [kv[0], Date.parse(kv[1])]; })
                        .sortBy(function(kv) { return kv[1]; })
                        .value();
                // a recursive error handler
                function try_last() {
                    var last = sorted.pop();
                    if(!last)
                        return result.new_notebook();
                    else
                        return result.load_notebook(last[0], null)
                        .catch(function(err) {
                            RCloud.UI.session_pane.post_rejection(err);
                            if(/Not Found/.test(err))
                                rcloud.config.clear_recent_notebook(last);
                            // if we reach the limit, stop trying.  if loading fails for a reason that
                            // is not actually a loading problem then stop trying.
                            if(--tries_left === 0) {
                                var quit_err = new Error("Failed to load " + NOTEBOOK_LOAD_FAILS + " notebooks. Quitting.");
                                RCloud.UI.session_pane.post_rejection(quit_err);
                                return Promise.resolve(false);
                            }
                            else if(err.from_load)
                                return try_last();
                            else
                                return Promise.resolve(false);
                        });
                }
                return try_last();
            })
            .then(function(res) {
                RCloud.UI.session_pane.allow_clear = true;
                return res;
            });
    }

    var result = {
        init: function(opts) {
            var that = this;
            username_ = rcloud.username();
            var promise = load_everything().then(function() {
                if(opts.notebook) { // notebook specified in url
                    return that.load_notebook(opts.notebook, opts.version, opts.source)
                        .catch(function(xep) {
                            var message = "Could not open notebook " + opts.notebook;
                            if(opts.version)
                                message += " (version " + opts.version + ")";
                            RCloud.UI.fatal_dialog(message, "Continue", ui_utils.make_url('edit.html'));
                            throw xep;
                        });
                } else if(!opts.new_notebook && current_.notebook) {
                    return that.load_notebook(current_.notebook, current_.version)
                        .catch(function(xep) {
                            // if loading fails for a reason that is not actually a loading problem
                            // then don't keep trying.
                            if(xep.from_load)
                                open_last_loadable();
                            else throw xep;
                        });
                }
                else
                    return that.new_notebook();
            });
            $('#new-notebook').click(function(e) {
                e.preventDefault();
                e.stopPropagation();
                if(e.metaKey || e.ctrlKey) {
                    var url = ui_utils.make_url('edit.html', {new_notebook: true});
                    window.open(url, "_blank");
                }
                else
                    that.new_notebook();
            });
            var snf = result.star_notebook;
            star_notebook_button_ =
                ui_utils.twostate_icon($("#star-notebook"),
                                       snf.bind(this, true), snf.bind(this, false),
                                       'icon-star', 'icon-star-empty');
            return promise;
        },
        // partial access to state, for add-ons.  (should be explicit model)
        username: function() {
            return username_;
        },
        gist_sources: function() {
            return gist_sources_;
        },
        num_stars: function(gistname) {
            return num_stars_[gistname] || 0;
        },
        i_starred: function(gistname) {
            return my_stars_[gistname] || false;
        },
        current: function() {
            return current_;
        },
        get_notebook_info: function(gistname) {
            return get_notebook_info(gistname);
        },
        // missing: friends, featured, histories
        fatal_reload: function(message) {
            var url = ui_utils.make_url('edit.html', {notebook: current_.notebook, version: current_.version});
            message = "<p>Sorry, RCloud's internal state has become inconsistent.  Please reload to return to a working state.</p><p>" + message + "</p>";
            RCloud.UI.fatal_dialog(message, "Reload", url);
        },
        create_book_tree_widget: function(data) {
            var that = this;

            var start_widget_time = window.performance ? window.performance.now() : 0;
            $tree_ = $("#editor-book-tree");
            $tree_.tree({
                data: data,
                onCreateLi: on_create_tree_li,
                selectable: true,
                keyboardSupport: false
            });
            $tree_.bind('tree.click', tree_click);
            $tree_.bind('tree.open', tree_open);
            $tree_.bind('tree.close', tree_close);
            if(start_widget_time)
                console.log('load tree took ' + (window.performance.now() - start_widget_time));
        },
        find_next_copy_name: function(name) {
            return find_next_copy_name(username_, name);
        },
        load_notebook: function(gistname, version, source, selroot, push_history) {
            var that = this;
            var before;
            if(source) {
                if(gist_sources_.indexOf(source)<0)
                    RCloud.UI.session_pane.append_text("Invalid gist source '" + source + "': ignored.");
                else if(!notebook_info_[gistname]) {
                    notebook_info_[gistname] = {source: source};
                    before = rcloud.set_notebook_property(gistname, "source", source);
                }
                // silently ignore valid source if notebook already known
            }
            before = before || Promise.resolve(undefined);
            selroot = selroot || true;
            return before.then(function() {
                return shell.load_notebook(gistname, version)
                    .then(that.load_callback({version: version,
                                              selroot: selroot,
                                              push_history: push_history}));
            });
        },
        open_notebook: function(gistname, version, selroot, new_window) {
            // really just load_notebook except possibly in a new window
            if(new_window) {
                var url = ui_utils.make_url('edit.html', {notebook: gistname, version: version});
                window.open(url, "_blank");
            }
            else
                this.load_notebook(gistname, version, null, selroot);
        },
        new_notebook_prefix: function(_) {
            if(arguments.length) {
                new_notebook_prefix_ = _;
                return this;
            }
            else return new_notebook_prefix_;
        },
        new_notebook: function() {
            var that = this;
            return Promise.cast(find_next_copy_name(username_, new_notebook_prefix_ + '1'))
                .then(shell.new_notebook.bind(shell))
                .then(function(notebook) {
                    set_visibility(notebook.id, true);
                    that.star_notebook(true, {notebook: notebook, make_current: true, version: null});
                });
        },
        validate_name: function(newname) {
            return newname && !_.some(newname.split('/'), Notebook.empty_for_github); // not null and no part of path is whitespace
        },
        rename_notebook: function(desc) {
            return shell.rename_notebook(desc);
        },
        tag_version: function(id, version, tag) {
            if(Notebook.empty_for_github(tag))
                tag = null;
            return rcloud.tag_notebook_version(id, version, tag)
                .then(function(ret) {
                    if(!ret)
                        return Promise.resolve(undefined);
                    var history = histories_[id];
                    for(var i=0; i<history.length; ++i) {
                        if (history[i].version === version) {
                            history[i].tag = tag;
                        }
                        if(history[i].tag === tag && history[i].version != version) {
                            history[i].tag = undefined;
                        }
                    }
                    var promises = [];
                    if(id === current_.notebook && version === current_.version) {
                        promises.push(update_url({notebook: id, version: version, tag: tag}));
                    }
                    promises.push(RCloud.UI.share_button.update_link());
                    return Promise.all(promises);
                });
        },
        update_notebook_from_gist: function(notebook) {
            update_notebook_from_gist(notebook, notebook.history, false);
        },
        for_each_notebook: function(node, data, leaff, combinef) {
            var that = this;
            if(node.children && node.children.length) {
                node.children.forEach(function(child) {
                    that.for_each_notebook(child, combinef ? combinef(child, data) : undefined,
                                           leaff, combinef);
                });
            }
            else {
                leaff(node, data);
            }
        },
        star_notebook: function(star, opts) {
            var that = this;
            // if opts has user and gistname use those
            // else if opts has notebook, use notebook id & user
            // else use current notebook & user
            opts = opts || {};
            var gistname = opts.gistname ||
                    opts.notebook&&opts.notebook.id ||
                    current_.notebook;
            var user = opts.user ||
                    opts.notebook&&opts.notebook.user&&opts.notebook.user.login ||
                    notebook_info_[gistname].username;
            // keep selected if was (but don't try to select a removed notebook)
            if(gistname === current_.notebook && opts.selroot === undefined)
                opts.selroot = true;
            if(star) {
                return rcloud.stars.star_notebook(gistname).then(function(count) {
                    num_stars_[gistname] = count;
                    var entry = get_notebook_info(gistname);
                    if(!entry.description && !opts.notebook) {
                        console.log("attempt to star notebook we have no record of",
                                    node_id('interests', user, gistname));
                        throw new Error("attempt to star notebook we have no record of",
                                        node_id('interests', user, gistname));
                    }
                    add_interest(user, gistname);
                    if(my_friends_[user] === 1)
                        change_folder_friendness(user);
                    if(opts.notebook) {
                        if(opts.make_current)
                            that.load_callback({
                                version: opts.version,
                                is_change: opts.is_change || false,
                                selroot: 'interests'})(opts.notebook);
                        else
                            update_notebook_from_gist(opts.notebook, opts.notebook.history, opts.selroot);
                    }
                    else {
                        update_notebook_view(user, gistname, entry, opts.selroot);
                    }
                });
            } else {
                return rcloud.stars.unstar_notebook(gistname).then(function(count) {
                    num_stars_[gistname] = count;
                    remove_interest(user, gistname);
                    if(!my_friends_[user])
                        change_folder_friendness(user);
                    unstar_notebook_view(user, gistname, opts.selroot);
                });
            }
        },
        remove_notebook: function(user, gistname) {
            var that = this;
            return (!this.i_starred(gistname) ? Promise.resolve() :
                    this.star_notebook(false, {user: user, gistname: gistname, selroot: false}))
                .then(function() {
                    remove_notebook_info(user, gistname);
                    remove_notebook_view(user, gistname);
                    var promise = rcloud.config.clear_recent_notebook(gistname);
                    if(gistname === current_.notebook)
                        promise = promise.then(open_last_loadable);
                    return promise;
                });
        },
        set_notebook_visibility: function(gistname, visible) {
            var promise = set_visibility(gistname, visible);
            update_notebook_view(username_, gistname, get_notebook_info(gistname), false);
            return promise;
        },
        set_terse_dates: function(val) {
            show_terse_dates_ = val;
        },
        star_and_public: function(notebook, make_current, is_change) {
            return this.star_notebook(true, {notebook: notebook,
                                             make_current: make_current,
                                             is_change: is_change,
                                             version: null})
                .return(notebook.id)
                .bind(this)
                .then(function(gistname) {
                    return this.set_notebook_visibility(gistname, true);
                });
        },
        fork_notebook: function(is_mine, gistname, version) {
            return shell.fork_notebook(is_mine, gistname, version)
                .bind(this)
                .then(function(notebook) {
                    return this.star_and_public(notebook, true, !!version);
                });
        },
        fork_folder: function(node, match, replace) {
            var that = this;
            var is_mine = node.user === that.username();
            editor.for_each_notebook(node, null, function(node) {
                var promise_fork;
                if(is_mine)
                    promise_fork = shell.fork_my_notebook(node.gistname, null, false, function(desc) {
                        return desc.replace(match, replace);
                    });
                else
                    promise_fork = rcloud.fork_notebook(node.gistname);
                return promise_fork.then(function(notebook) {
                    return editor.star_and_public(notebook, false, false);
                });
            });
            return this;
        },
        revert_notebook: function(is_mine, gistname, version) {
            if(!is_mine)
                return Promise.reject(new Error("attempted to revert notebook not mine"));
            if(!version)
                return Promise.reject(new Error("attempted to revert current version"));
            return shell.revert_notebook(gistname, version)
                .then(this.load_callback({is_change: true, selroot: true}));
        },
        show_history: function(node, opts) {
            if(_.isBoolean(opts))
                opts = {toggle: opts};
            var whither = opts.update ? 'same' : 'more';
            if(node.children.length) {
                if(!node.is_open) {
                    $tree_.tree('openNode', node);
                    return;
                }
                if(opts.toggle) whither = 'hide';
            }
            update_history_nodes(node, whither, null)
                .then(function(node) {
                    var history_len = 0;
                    if(histories_[node.gistname]) {
                        history_len = histories_[node.gistname].length;
                    }
                    if(history_len==1) { // FIXME: should be via UI.notebook_commands
                        $(".history i",$(node.element)).addClass("button-disabled");
                    }
                    $tree_.tree('openNode', node);
                });
        },
        load_callback: function(opts) {
            var that = this;
            var options = $.extend(
                {version: null,
                 is_change: false,
                 selroot: null,
                 push_history: true}, opts);
            return function(result) {
                var promises = []; // fetch and setup various ui "in parallel"
                current_ = {notebook: result.id, version: options.version};
                var tag;
                var find_version = _.find(result.history, function(x) { return x.version === options.version; });
                if(find_version)
                    tag = find_version.tag;
                rcloud.config.set_current_notebook(current_);
                rcloud.config.set_recent_notebook(result.id, (new Date()).toString());

                promises.push(RCloud.UI.share_button.update_link());

                document.title = result.description + " - RCloud";
                promises.push(update_url({notebook: result.id, version: options.version, tag:tag}));

                var history;
                // when loading an old version you get truncated history
                // we don't want that, even if it means an extra fetch
                if(options.version)
                    history = null;
                else
                    history = result.history;

                promises.push((_.has(num_stars_, result.id) ? Promise.resolve(undefined)
                               : rcloud.stars.get_notebook_star_count(result.id).then(function(count) {
                                   num_stars_[result.id] = count;
                               })).then(function() {
                                   update_notebook_from_gist(result, history, options.selroot);
                               }));

                promises.push(RCloud.UI.comments_frame.display_comments());
                promises.push(rcloud.is_notebook_published(result.id).then(function(p) {
                    RCloud.UI.advanced_menu.check('publish_notebook', p);
                    RCloud.UI.advanced_menu.enable('publish_notebook', result.user.login === username_);
                }));
                return Promise.all(promises).return(result);
            };
        }
    };
    return result;
}();
