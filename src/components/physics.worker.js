import { lerp } from '../helpers'
import AmmoJS from "../ammo/ammo.wasm.es.js"

// Firefox limitation: https://github.com/vitejs/vite/issues/4586

// there's probably a better place for these variables
let bodies = []
let sleepingBodies = []
let colliders = {}
let physicsWorld
let Ammo
let worldWorkerPort
let tmpBtTrans
let sharedVector3
let width = 150
let height = 150
let aspect = 1
let stopLoop = false

const defaultOptions = {
	size: 9.5,
	startingHeight: 8,
	spinForce: 6,
	throwForce: 5,
	gravity: 1,
	mass: 1,
	friction: .8,
	restitution: .1,
	linearDamping: .5,
	angularDamping: .4,
	settleTimeout: 5000,
	impactThreshold: .22,
	impactCooldown: 110,
	impactReleaseMs: 240,
	impactRetriggerDelta: .5,
	impactNormalVelocityFloor: .42,
	impactImpulseFloor: .55,
	impactReleaseThreshold: .1,
	impactReleaseNormalVelocityFloor: .18,
	// TODO: toss: "center", "edge", "allEdges"
}

let config = {...defaultOptions}

let emptyVector
let diceBufferView
let contactStateByBucket = {}

self.onmessage = (e) => {
  switch (e.data.action) {
    case "rollDie":
      rollDie(e.data.sides)
      break;
    case "init":
      init(e.data).then(()=>{
        self.postMessage({
          action:"init-complete"
        })
      })
      break
    case "clearDice":
			clearDice()
      break
		case "removeDie":
			removeDie(e.data.id)
			break;
		case "resize":
			width = e.data.width
			height = e.data.height
			aspect = width / height
			addBoxToWorld(config.size, config.startingHeight + 10)
			break
		case "updateConfig":
			updateConfig(e.data.options)
			break
    case "connect":
      worldWorkerPort = e.ports[0]
      worldWorkerPort.onmessage = (e) => {
        switch (e.data.action) {
					case "initBuffer":
						diceBufferView = new Float32Array(e.data.diceBuffer)
						diceBufferView[0] = -1
						break;
					case "loadModels":
						// console.log('e.data', e.data)
						loadModels(e.data.options)
						break;
          case "addDie":
						// toss from all edges
						// setStartPosition()
						if(e.data.options.newStartPoint){
							setStartPosition()
						}
            const newDie = addDie(e.data.options)
						rollDie(newDie)
            break;
          case "rollDie":
						// TODO: this won't work, need a die object
            rollDie(e.data.id)
            break;
					case "removeDie":
						removeDie(e.data.id)
						break;
          case "stopSimulation":
            stopLoop = true
						
            break;
          case "resumeSimulation":
						if(e.data.newStartPoint){
							setStartPosition()
						}
            stopLoop = false
						loop()
            break;
					case "stepSimulation":
						diceBufferView = new Float32Array(e.data.diceBuffer)
						loop()
						break;
          default:
            console.error("action not found in physics worker from worldOffscreen worker:", e.data.action)
        }
      }
      break
    default:
      console.error("action not found in physics worker:", e.data.action)
  }
}


const computeGravity = (gravity = defaultOptions.gravity, mass = defaultOptions.mass) => {
	// make gravity a little bit stronger for heavy objects, so they seem heavier
	return gravity === 0 ? 0 : gravity + mass / 3
}

const computeMass = (mass = defaultOptions.mass) => {
	// high values in mass are pretty ineffective, but whole intigers make better config values, so we shave down the value
	// also prevents mass from ever being zero
	return 1 + mass / 3
}

const computeSpin = (spin = defaultOptions.spinForce, spinScale = 40) => {
	// scale down the actual spin value from a nice intiger in config to a fractional value
	return spin/spinScale
}

const computeThrowForce = (throwForce = defaultOptions.throwForce, mass = defaultOptions.mass, scale = defaultOptions.scale) => {
	return throwForce / 2 / mass * (1 + scale / 6)
}

const computeStartingHeight = (height = defaultOptions.startingHeight) => {
	// ensure minimum startingHeight of 1
	return height < 1 ? 1 : height
}



// runs when the worker loads to set up the Ammo physics world and load our colliders
// loaded colliders will be cached and added to the world in a later post message
const init = async (data) => {
	width = data.width
	height = data.height
	aspect = width / height

	config = {...config,...data.options}
	config.gravity = computeGravity(config.gravity, config.mass)
	config.mass = computeMass(config.mass)
	config.spinForce = computeSpin(config.spinForce)
	config.throwForce = computeThrowForce(config.throwForce,config.mass,config.scale)
	config.startingHeight = computeStartingHeight(config.startingHeight)

	const ammoWASM = {
		// locateFile: () => '../../node_modules/ammo.js/builds/ammo.wasm.wasm'
		locateFile: () => `${config.origin + config.assetPath}ammo/ammo.wasm.wasm`
	}

	Ammo = await new AmmoJS(ammoWASM)

	tmpBtTrans = new Ammo.btTransform()
	sharedVector3 = new Ammo.btVector3(0, 0, 0)
	emptyVector = setVector3(0,0,0)

	setStartPosition()
	
	physicsWorld = setupPhysicsWorld()

	addBoxToWorld(config.size, config.startingHeight + 10)
}

const updateConfig = (options) => {
	config = {...config, ...options}
	if(options.mass){
		config.mass = computeMass(config.mass)
	}
	if(options.mass || options.gravity) {
		config.gravity = computeGravity(config.gravity, config.mass)
	}
	
	if(options.spinForce) {
		config.spinForce = computeSpin(config.spinForce)
	}
	if(options.throwForce || options.mass || options.scale){
		config.throwForce = computeThrowForce(config.throwForce, config.mass, config.scale)
	}
	if(options.startingHeight) {
		computeStartingHeight(config.startingHeight)
	}

	removeBoxFromWorld()
	addBoxToWorld(config.size, config.startingHeight + 10)
	physicsWorld.setGravity(setVector3(0, -9.81 * config.gravity, 0))
	Object.values(colliders).map((collider) => {
		collider.convexHull.setLocalScaling(setVector3(collider.scaling[0] * config.scale, collider.scaling[1] * config.scale, collider.scaling[2] * config.scale))
	})
}

// options object with colliders and meshName are required
const loadModels = async ({colliders: modelData, meshName}) => {

	let has_d100 = false
	let has_d10 = false

	// turn our model data into convex hull items for the physics world
	modelData.forEach((model,i) => {
		colliders[meshName + '_' + model.name] = model
		colliders[meshName + '_' + model.name].convexHull = createConvexHull(model)
		if (!has_d10) {
			has_d10 = model.id === "d10_collider"
		}
		if (!has_d100) {
			has_d100 = model.id === "d100_collider"
		}
	})
	if (!has_d100 && has_d10) {
		colliders[`${meshName}_d100_collider`] = colliders[`${meshName}_d10_collider`]
	}
}

const setVector3 = (x,y,z) => {
	sharedVector3.setValue(x,y,z)
	return sharedVector3
}

const setStartPosition = () => {
	let size = config.size
	// let envelopeSize = size * .6 / 2
	let edgeOffset = .5
	let xMin = size * aspect / 2 - edgeOffset
	let xMax = size * aspect / -2 + edgeOffset
	let yMin = size / 2 - edgeOffset
	let yMax = size / -2 + edgeOffset
	// let xEnvelope = lerp(envelopeSize * aspect - edgeOffset * aspect, -envelopeSize * aspect + edgeOffset * aspect, Math.random())
	let xEnvelope = lerp(xMin, xMax, Math.random())
	let yEnvelope = lerp(yMin, yMax, Math.random())
	let tossFromTop = Math.round(Math.random())
	let tossFromLeft = Math.round(Math.random())
	let tossX = Math.round(Math.random())
	// console.log(`throw coming from`, tossX ? tossFromTop ? "top" : "bottom" : tossFromLeft ? "left" : "right")

	// forces = {
	// 	xMinForce: tossX ? -config.throwForce * aspect : tossFromLeft ? config.throwForce * aspect * .3 : -config.throwForce * aspect * .3,
	// 	xMaxForce: tossX ? config.throwForce * aspect : tossFromLeft ? config.throwForce * aspect * 1 : -config.throwForce * aspect * 1,
	// 	zMinForce: tossX ? tossFromTop ? config.throwForce * .3 : -config.throwForce * .3 : -config.throwForce,
	// 	zMaxForce: tossX ? tossFromTop ? config.throwForce * 1 : -config.throwForce * 1 : config.throwForce,
	// }

	config.startPosition = [
		// tossing on x axis then z should be locked to top or bottom
		// not tossing on x axis then x should be locked to the left or right
		tossX ? xEnvelope : tossFromLeft ? xMax : xMin,
		config.startingHeight,
		tossX ? tossFromTop ? yMax : yMin : yEnvelope
	]

	// console.log(`startPosition`, config.startPosition)
}

const createConvexHull = (mesh) => {
	const convexMesh = new Ammo.btConvexHullShape()

	let count = mesh.positions.length

	for (let i = 0; i < count; i+=3) {
		let v = setVector3(mesh.positions[i], mesh.positions[i+1], mesh.positions[i+2])
		convexMesh.addPoint(v, true)
	}
	
	convexMesh.setLocalScaling(setVector3(mesh.scaling[0] * config.scale, mesh.scaling[1] * config.scale, mesh.scaling[2] * config.scale))

	return convexMesh
}

const createRigidBody = (collisionShape, params) => {
	// apply params
	const {
		mass = .1,
		collisionFlags = 0,
		// pos = { x: 0, y: 0, z: 0 },
		// quat = { x: 0, y: 0, z: 0, w: 1 }
		pos = [0,0,0],
		// quat = [0,0,0,-1],
		quat = [
			lerp(-1.5, 1.5, Math.random()),
			lerp(-1.5, 1.5, Math.random()),
			lerp(-1.5, 1.5, Math.random()),
			-1
		],
		scale = [1,1,1],
		friction = config.friction,
		restitution = config.restitution
	} = params

	// apply position and rotation
	const transform = new Ammo.btTransform()
	// console.log(`collisionShape scaling `, collisionShape.getLocalScaling().x(),collisionShape.getLocalScaling().y(),collisionShape.getLocalScaling().z())
	transform.setIdentity()
	transform.setOrigin(setVector3(pos[0], pos[1], pos[2]))
	transform.setRotation(
		new Ammo.btQuaternion(quat[0], quat[1], quat[2], quat[3])
	)
	// collisionShape.setLocalScaling(new Ammo.btVector3(1.1, -1.1, 1.1))
	// transform.ScalingToRef()
	// set the scale of the collider
	// collisionShape.setLocalScaling(new Ammo.btVector3(scale[0],scale[1],scale[2]))

	// create the rigid body
	const motionState = new Ammo.btDefaultMotionState(transform)
	const localInertia = setVector3(0, 0, 0)
	if (mass > 0) collisionShape.calculateLocalInertia(mass, localInertia)
	const rbInfo = new Ammo.btRigidBodyConstructionInfo(
		mass,
		motionState,
		collisionShape,
		localInertia
	)
	const rigidBody = new Ammo.btRigidBody(rbInfo)
	
	// rigid body properties
	if (mass > 0) rigidBody.setActivationState(4) // Disable deactivation
	rigidBody.setCollisionFlags(collisionFlags)
	rigidBody.setFriction(friction)
	rigidBody.setRestitution(restitution)
	rigidBody.setDamping(config.linearDamping, config.angularDamping)

	// ad rigid body to physics world
	// physicsWorld.addRigidBody(rigidBody)

	return rigidBody

}
// cache for box parts so it can be removed after a new one has been made
let boxParts = []
const addBoxToWorld = (size, height) => {
	const tempParts = []
	// ground
	const localInertia = setVector3(0, 0, 0);

	const groundTransform = new Ammo.btTransform()
	groundTransform.setIdentity()
	groundTransform.setOrigin(setVector3(0, -.5, 0))
	const groundShape = new Ammo.btBoxShape(setVector3(size * aspect, 1, size))
	const groundMotionState = new Ammo.btDefaultMotionState(groundTransform)
	const groundInfo = new Ammo.btRigidBodyConstructionInfo(0, groundMotionState, groundShape, localInertia)
	const groundBody = new Ammo.btRigidBody(groundInfo)
	groundBody.id='box_bottom'
	groundBody.setFriction(config.friction)
	groundBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(groundBody)
	tempParts.push(groundBody)

	const ceilingTransform = new Ammo.btTransform()
	ceilingTransform.setIdentity()
	ceilingTransform.setOrigin(setVector3(0, height - .5, 0))
	const ceilingShape = new Ammo.btBoxShape(setVector3(size * aspect, 1, size))
	const ceilingMotionState = new Ammo.btDefaultMotionState(ceilingTransform)
	const ceilingInfo = new Ammo.btRigidBodyConstructionInfo(0, ceilingMotionState, ceilingShape, localInertia)
	const ceilingBody = new Ammo.btRigidBody(ceilingInfo)
	ceilingBody.id='box_top'
	ceilingBody.setFriction(config.friction)
	ceilingBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(ceilingBody)
	tempParts.push(ceilingBody)

	const wallTopTransform = new Ammo.btTransform()
	wallTopTransform.setIdentity()
	wallTopTransform.setOrigin(setVector3(0, 0, (size/-2) - .5))
	const wallTopShape = new Ammo.btBoxShape(setVector3(size * aspect, height, 1))
	const topMotionState = new Ammo.btDefaultMotionState(wallTopTransform)
	const topInfo = new Ammo.btRigidBodyConstructionInfo(0, topMotionState, wallTopShape, localInertia)
	const topBody = new Ammo.btRigidBody(topInfo)
	topBody.id='box_wall_north'
	topBody.setFriction(config.friction)
	topBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(topBody)
	tempParts.push(topBody)

	const wallBottomTransform = new Ammo.btTransform()
	wallBottomTransform.setIdentity()
	wallBottomTransform.setOrigin(setVector3(0, 0, (size/2) + .5))
	const wallBottomShape = new Ammo.btBoxShape(setVector3(size * aspect, height, 1))
	const bottomMotionState = new Ammo.btDefaultMotionState(wallBottomTransform)
	const bottomInfo = new Ammo.btRigidBodyConstructionInfo(0, bottomMotionState, wallBottomShape, localInertia)
	const bottomBody = new Ammo.btRigidBody(bottomInfo)
	bottomBody.id='box_wall_south'
	bottomBody.setFriction(config.friction)
	bottomBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(bottomBody)
	tempParts.push(bottomBody)

	const wallRightTransform = new Ammo.btTransform()
	wallRightTransform.setIdentity()
	wallRightTransform.setOrigin(setVector3((size * aspect / -2) - .5, 0, 0))
	const wallRightShape = new Ammo.btBoxShape(setVector3(1, height, size))
	const rightMotionState = new Ammo.btDefaultMotionState(wallRightTransform)
	const rightInfo = new Ammo.btRigidBodyConstructionInfo(0, rightMotionState, wallRightShape, localInertia)
	const rightBody = new Ammo.btRigidBody(rightInfo)
	rightBody.id='box_wall_east'
	rightBody.setFriction(config.friction)
	rightBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(rightBody)
	tempParts.push(rightBody)

	const wallLeftTransform = new Ammo.btTransform()
	wallLeftTransform.setIdentity()
	wallLeftTransform.setOrigin(setVector3((size * aspect / 2) + .5, 0, 0))
	const wallLeftShape = new Ammo.btBoxShape(setVector3(1, height, size))
	const leftMotionState = new Ammo.btDefaultMotionState(wallLeftTransform)
	const leftInfo = new Ammo.btRigidBodyConstructionInfo(0, leftMotionState, wallLeftShape, localInertia)
	const leftBody = new Ammo.btRigidBody(leftInfo)
	leftBody.id='box_wall_west'
	leftBody.setFriction(config.friction)
	leftBody.setRestitution(config.restitution)
	physicsWorld.addRigidBody(leftBody)
	tempParts.push(leftBody)

	if(boxParts.length){
		removeBoxFromWorld()
	}
	boxParts = [...tempParts]
}

const removeBoxFromWorld = () => {
	boxParts.forEach(part => physicsWorld.removeRigidBody(part))
}

const addDie = (options) => {
	const { sides, id, meshName, scale} = options
	const dieType = Number.isInteger(sides) ? `d${sides}` : sides
	let cType = `${dieType}_collider`
	const comboKey = `${meshName}_${cType}`
	const colliderMass = colliders[comboKey]?.physicsMass || .1
	const mass = colliderMass * config.mass * config.scale // feature? mass should go up with scale, but it throws off the throwForce and spinForce scaling
	// TODO: incorporate colliders physicsFriction and physicsRestitution settings
	// clone the collider
	const newDie = createRigidBody(colliders[comboKey].convexHull, {
		mass,
		scaling: colliders[comboKey].scaling,
		pos: config.startPosition,
		// quat: colliders[cType].rotationQuaternion,
	})
	newDie.id = id
	newDie.timeout = config.settleTimeout
	newDie.mass = mass
	physicsWorld.addRigidBody(newDie)
	bodies.push(newDie)

	return newDie
	// console.log(`added collider for `, type)
	// rollDie(newDie)
}

const rollDie = (die) => {

	// lerp picks a random number between two values
	die.setLinearVelocity(setVector3(
		lerp(-config.startPosition[0] * .5, -config.startPosition[0] * config.throwForce, Math.random()),
		lerp(-config.startPosition[1], -config.startPosition[1] * 2, Math.random()), // limit the y force to 2
		lerp(-config.startPosition[2] * .5, -config.startPosition[2] * config.throwForce, Math.random()),
	))

	const flippy = Math.random() > .5 ? 1 : -1 // random positive or negative number
	const spinny = lerp(config.spinForce * .5, config.spinForce, Math.random())
	const force = new Ammo.btVector3(
		spinny * flippy,
		spinny * -flippy, // flip the flippy to avoid gimble lock
		spinny * flippy
	)

	// attempting to create an envelope for the force influence based on scale and mass
	// linear scale was no good - this creates a nice power curve
	const scale = Math.abs(config.scale - 1) + config.scale * config.scale * (die.mass/config.mass) * .75

	// console.log('scale', scale)
	
	die.applyImpulse(force, setVector3(scale, scale, scale))

}

const removeDie = (id) => {
	sleepingBodies = sleepingBodies.filter((die) => {
		let match = die.id === id
		if(match){
			// remove the mesh from the scene
			physicsWorld.removeRigidBody(die)
		}
		return !match
	})

	// step the animation forward
	// requestAnimationFrame(loop)
}

const clearDice = () => {
	if(diceBufferView.byteLength){
		diceBufferView.fill(0)
	}
	stopLoop = true
	contactStateByBucket = {}
	// clear all bodies
	bodies.forEach(body => physicsWorld.removeRigidBody(body))
	sleepingBodies.forEach(body => physicsWorld.removeRigidBody(body))
	// clear cache arrays
	bodies = []
	sleepingBodies = []
}


const setupPhysicsWorld = () => {
	const collisionConfiguration = new Ammo.btDefaultCollisionConfiguration()
	const broadphase = new Ammo.btDbvtBroadphase()
	const solver = new Ammo.btSequentialImpulseConstraintSolver()
	const dispatcher = new Ammo.btCollisionDispatcher(collisionConfiguration)
	const World = new Ammo.btDiscreteDynamicsWorld(
		dispatcher,
		broadphase,
		solver,
		collisionConfiguration
	)
	World.setGravity(setVector3(0, -9.81 * config.gravity, 0))

	return World
}

const isBoxBody = (bodyId) => typeof bodyId === 'string' && bodyId.startsWith('box_')

const isActiveDieBody = (bodyId) => bodies.some((body) => body.id === bodyId)

const getImpactKind = (body0Id, body1Id) => {
	if(body0Id === 'box_bottom' || body1Id === 'box_bottom') return 'surface'
	if(isBoxBody(body0Id) || isBoxBody(body1Id)) return 'wall'
	if(isActiveDieBody(body0Id) && isActiveDieBody(body1Id)) return 'die'
	return 'unknown'
}

const negateVector = (vector) => ({
	x: -vector.x,
	y: -vector.y,
	z: -vector.z
})

const toLocalVector = (rigidBody, worldVector) => {
	const rotation = rigidBody.getWorldTransform().getRotation()
	const x = rotation.x()
	const y = rotation.y()
	const z = rotation.z()
	const w = rotation.w()

	const ix = w * worldVector.x + y * worldVector.z - z * worldVector.y
	const iy = w * worldVector.y + z * worldVector.x - x * worldVector.z
	const iz = w * worldVector.z + x * worldVector.y - y * worldVector.x
	const iw = x * worldVector.x + y * worldVector.y + z * worldVector.z

	return {
		x: ix * w + iw * x - iy * z + iz * y,
		y: iy * w + iw * y - iz * x + ix * z,
		z: iz * w + iw * z - ix * y + iy * x
	}
}

const getAxisSign = (axis, value) => `${axis}${value >= 0 ? '+' : '-'}`

const getBucketFromLocalNormal = (localNormal) => {
	const components = [
		{ axis: 'x', value: localNormal.x, abs: Math.abs(localNormal.x) },
		{ axis: 'y', value: localNormal.y, abs: Math.abs(localNormal.y) },
		{ axis: 'z', value: localNormal.z, abs: Math.abs(localNormal.z) }
	].sort((left, right) => right.abs - left.abs)

	const [first, second, third] = components
	if(first.abs > .84 && second.abs < .42) {
		return `face:${getAxisSign(first.axis, first.value)}`
	}

	if(third.abs < .32) {
		const edgeAxes = [getAxisSign(first.axis, first.value), getAxisSign(second.axis, second.value)].sort()
		return `edge:${edgeAxes.join(':')}`
	}

	const cornerAxes = [
		getAxisSign(first.axis, first.value),
		getAxisSign(second.axis, second.value),
		getAxisSign(third.axis, third.value)
	].sort()
	return `corner:${cornerAxes.join(':')}`
}

const getContactBucketKey = (rigidBody, bodyId, kind, worldNormal) => {
	const localNormal = toLocalVector(rigidBody, worldNormal)
	return `${bodyId}:${kind}:${getBucketFromLocalNormal(localNormal)}`
}

const evaluateImpactCandidate = ({
	now,
	rigidBody,
	bodyId,
	kind,
	worldNormal,
	intensity,
	maxImpulse,
	maxNormalVelocity,
	activeBucketKeys
}) => {
	const bucketKey = getContactBucketKey(rigidBody, bodyId, kind, worldNormal)
	activeBucketKeys.add(bucketKey)

	const previous = contactStateByBucket[bucketKey]
	const releaseSatisfied = !previous
		|| previous.armed
		|| now - previous.lastSeenAt > config.impactReleaseMs
		|| intensity <= config.impactReleaseThreshold
		|| maxNormalVelocity <= config.impactReleaseNormalVelocityFloor
	const isHardRetrigger = previous
		&& !releaseSatisfied
		&& intensity >= previous.peakIntensity + config.impactRetriggerDelta
		&& now - previous.lastImpactAt > config.impactCooldown
	const hasEnoughImpact = maxNormalVelocity >= config.impactNormalVelocityFloor || maxImpulse >= config.impactImpulseFloor

	contactStateByBucket[bucketKey] = {
		lastSeenAt: now,
		lastImpactAt: previous?.lastImpactAt || 0,
		peakIntensity: releaseSatisfied ? intensity : Math.max(previous?.peakIntensity || 0, intensity),
		armed: releaseSatisfied
	}

	if(intensity < config.impactThreshold || !hasEnoughImpact) {
		if(intensity <= config.impactReleaseThreshold || maxNormalVelocity <= config.impactReleaseNormalVelocityFloor) {
			contactStateByBucket[bucketKey].armed = true
			contactStateByBucket[bucketKey].peakIntensity = intensity
		}
		return null
	}

	if(!contactStateByBucket[bucketKey].armed && !isHardRetrigger) {
		return null
	}

	contactStateByBucket[bucketKey].armed = false
	contactStateByBucket[bucketKey].lastImpactAt = now
	contactStateByBucket[bucketKey].peakIntensity = intensity

	return {
		action: "collision",
		body0Id: bodyId,
		body1Id: bucketKey,
		kind,
		intensity,
		impulse: maxImpulse,
		velocity: maxNormalVelocity,
		at: now
	}
}

const reportImpacts = () => {
	const now = Date.now()
	const numManifolds = physicsWorld.getDispatcher().getNumManifolds()
	const activeBucketKeys = new Set()

	for (let i = 0; i < numManifolds; i++) {
		const contactManifold = physicsWorld.getDispatcher().getManifoldByIndexInternal(i)
		const body0 = Ammo.castObject(contactManifold.getBody0(), Ammo.btRigidBody)
		const body1 = Ammo.castObject(contactManifold.getBody1(), Ammo.btRigidBody)
		const body0Id = body0.id
		const body1Id = body1.id

		if(!isActiveDieBody(body0Id) && !isActiveDieBody(body1Id)) {
			continue
		}

		let maxImpulse = 0
		let maxNormalVelocity = 0
		let hasContact = false
		let representativeNormal = null
		const numContacts = contactManifold.getNumContacts()

		for (let j = 0; j < numContacts; j++) {
			const contactPoint = contactManifold.getContactPoint(j)

			if (contactPoint.getDistance() > .02) {
				continue
			}

			hasContact = true
			maxImpulse = Math.max(maxImpulse, Math.abs(contactPoint.getAppliedImpulse()))

			const normal = contactPoint.get_m_normalWorldOnB()
			if(!representativeNormal) {
				representativeNormal = {
					x: normal.x(),
					y: normal.y(),
					z: normal.z()
				}
			}
			const velocity0 = body0.getLinearVelocity()
			const velocity1 = body1.getLinearVelocity()
			const relativeX = velocity0.x() - velocity1.x()
			const relativeY = velocity0.y() - velocity1.y()
			const relativeZ = velocity0.z() - velocity1.z()
			const normalVelocity = Math.abs(
				normal.x() * relativeX
				+ normal.y() * relativeY
				+ normal.z() * relativeZ
			)
			maxNormalVelocity = Math.max(maxNormalVelocity, normalVelocity)
		}

		if(!hasContact) {
			continue
		}

		const intensity = Math.min(1, Math.max(maxImpulse / 3.5, maxNormalVelocity / 8.5))
		const kind = getImpactKind(body0Id, body1Id)
		const worldNormal = representativeNormal

		if(isActiveDieBody(body0Id)) {
			const event = evaluateImpactCandidate({
				now,
				rigidBody: body0,
				bodyId: body0Id,
				kind,
				worldNormal: negateVector(worldNormal),
				intensity,
				maxImpulse,
				maxNormalVelocity,
				activeBucketKeys
			})
			if(event) {
				event.body1Id = body1Id
				self.postMessage(event)
			}
		}

		if(isActiveDieBody(body1Id)) {
			const event = evaluateImpactCandidate({
				now,
				rigidBody: body1,
				bodyId: body1Id,
				kind,
				worldNormal,
				intensity,
				maxImpulse,
				maxNormalVelocity,
				activeBucketKeys
			})
			if(event) {
				event.body1Id = body0Id
				self.postMessage(event)
			}
		}
	}

	Object.entries(contactStateByBucket).forEach(([bucketKey, contact]) => {
		if(!activeBucketKeys.has(bucketKey) && now - contact.lastSeenAt > config.impactReleaseMs) {
			delete contactStateByBucket[bucketKey]
		}
	})
}

const update = (delta) => {
	// step world
	const deltaTime = delta / 1000
	
	// console.time("stepSimulation")
	physicsWorld.stepSimulation(deltaTime, 2, 1 / 90) // higher number = slow motion
	// console.timeEnd("stepSimulation")

	diceBufferView[0] = bodies.length

	reportImpacts()

	// looping backwards since bodies are removed as they are put to sleep
	for (let i = bodies.length - 1; i >= 0; i--) {
		const rb = bodies[i]
		const speed = rb.getLinearVelocity().length()
		const tilt = rb.getAngularVelocity().length()

		if(speed < .01 && tilt < .005 || rb.timeout < 0) {
			// flag the second param for this body so it can be processed in World, first param will be the roll.id
			diceBufferView[(i*8) + 1] = rb.id
			diceBufferView[(i*8) + 2] = -1
			rb.asleep = true
			rb.setMassProps(0)
			rb.forceActivationState(3)
			// zero out anything left
			rb.setLinearVelocity(emptyVector)
			rb.setAngularVelocity(emptyVector)
			sleepingBodies.push(bodies.splice(i,1)[0])
			continue
		}
		// tick down the movement timeout on this die
		rb.timeout -= delta
		const ms = rb.getMotionState()
		if (ms) {
			ms.getWorldTransform(tmpBtTrans)
			let p = tmpBtTrans.getOrigin()
			let q = tmpBtTrans.getRotation()
			let j = i*8 + 1

			diceBufferView[j] = rb.id
			diceBufferView[j+1] = p.x()
			diceBufferView[j+2] = p.y()
			diceBufferView[j+3] = p.z()
			diceBufferView[j+4] = q.x()
			diceBufferView[j+5] = q.y()
			diceBufferView[j+6] = q.z()
			diceBufferView[j+7] = q.w()
		}
	}
}

let last = new Date().getTime()
const loop = () => {
	let now = new Date().getTime()
	const delta = now - last
	last = now

	if(!stopLoop && diceBufferView.byteLength) {
		// console.time("physics")
		update(delta)
		// console.timeEnd("physics")
			worldWorkerPort.postMessage({
				action: 'updates',
				diceBuffer: diceBufferView.buffer
			}, [diceBufferView.buffer])
	}
}
